/**
 * Pinet host extension.
 *
 * Onboarding happens inside pi: run `/pinet setup`. It shows a short code and
 * a URL, opens the browser for Google SSO + MFA, and completes enrollment and
 * connection without any separate CLI. `/pinet status`, `/pinet reconnect`, and
 * `/pinet logout` manage the connection afterwards.
 *
 * Headless alternative: set PINET_ENROLL_CODE (and PINET_HUB/PINET_HTTP) and the
 * extension enrolls on startup.
 *
 * Env: PINET_HUB, PINET_HTTP, PINET_DIR, PINET_ENROLL_CODE.
 */

import { hostname } from "node:os";
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostBridge } from "../src/host/bridge.mjs";
import { createSerialQueue } from "../src/host/command-queue.mjs";
import { resolveDelivery } from "../src/host/delivery.mjs";
import { clearHostState, ensureHostKeys, enrollHostWithCode, loadHostState, onboardHost, saveHostState } from "../src/host/onboarding.mjs";
import { SessionSpawner, detectGit, detectTmux } from "../src/host/spawner.mjs";

type Json = Record<string, unknown>;
type Pi = ExtensionAPI;

// Spawned children are killed when the pi process exits. Installed once so
// repeated extension loads (e.g. in tests) don't stack exit listeners.
const liveSpawners = new Set<SessionSpawner>();
let exitHookInstalled = false;
function trackSpawner(spawner: SessionSpawner): void {
  liveSpawners.add(spawner);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const live of liveSpawners) live.shutdown();
  });
}

function deriveHttp(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

export default function pinet(pi: Pi): void {
  const dir = process.env.PINET_DIR ?? `${process.env.HOME ?? "."}/.pinet`;
  const hubUrl = process.env.PINET_HUB ?? "ws://127.0.0.1:8787/ws";
  const httpUrl = process.env.PINET_HTTP ?? deriveHttp(hubUrl);
  const enrollCode = process.env.PINET_ENROLL_CODE;

  let bridge: HostBridge | undefined;
  let activeCtx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let sentIds: string[] = [];
  const runningTools = new Map<string, { toolName: string; args: unknown }>();
  const queue = createSerialQueue();
  let currentRun: { id: string; startedAt: number } | undefined;
  let compacting: { reason: string } | undefined;
  let runCounter = 0;

  // Session spawner (see src/host/spawner.mjs). `PINET_SPAWN_MODE=off` disables it.
  const spawner = new SessionSpawner({
    cwd: process.cwd(),
    mode: process.env.PINET_SPAWN_MODE ?? "session",
    max: Number(process.env.PINET_SPAWN_MAX ?? 8),
    piBin: process.env.PINET_PI_BIN ?? "pi",
  });
  trackSpawner(spawner);
  // With tmux the spawned session gets a TTY and outlives this process, so a
  // spawner restart no longer takes spawned sessions down with it.
  void detectTmux().then((tmux) => {
    spawner.tmux = tmux;
  });


  function notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
      ctx?.ui.notify(message, type);
    } catch {
      /* no UI */
    }
  }

  /**
   * Lifecycle trace, appended to `<dir>/host.log`. Small (a handful of lines per
   * process) and invaluable when a host connects but never registers a session.
   */
  function trace(stage: string, detail = ""): void {
    try {
      appendFileSync(`${dir}/host.log`, `${new Date().toISOString()} ${stage}${detail ? ` ${detail}` : ""}\n`, { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  /**
   * Startup/registration failures used to be swallowed by a bare catch, which
   * made a host that connected but never registered impossible to diagnose.
   * Log to the host dir (and stderr) so `~/.pinet/error.log` tells the story.
   */
  function reportError(stage: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    trace(`error ${stage}`, message);
    try {
      appendFileSync(`${dir}/error.log`, `${new Date().toISOString()} ${stage}: ${message}\n`, { mode: 0o600 });
    } catch {
      /* best effort */
    }
    try {
      console.error(`[pinet] ${stage}: ${message}`);
    } catch {
      /* no console */
    }
  }

  function openUrl(url: string): void {
    try {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      void pi.exec(command, args).catch(() => {});
    } catch {
      /* user can open the shown URL */
    }
  }

  // -- session snapshot/status extraction -----------------------------------

  function buildStatus(ctx: ExtensionContext): Json {
    const model = ctx.model;
    return {
      phase: ctx.isIdle() ? "idle" : "running",
      isIdle: ctx.isIdle(),
      model: model ? { provider: model.provider, id: model.id, name: model.name } : null,
      thinkingLevel: ctx.thinkingLevel ?? null,
      contextUsage: ctx.getContextUsage() ?? null,
      runningTools: [...runningTools.entries()].map(([toolCallId, tool]) => ({ toolCallId, toolName: tool.toolName, args: tool.args })),
      run: currentRun ? { id: currentRun.id, startedAt: currentRun.startedAt, state: "running" } : null,
      compacting: compacting ? { reason: compacting.reason } : null,
    };
  }

  function buildMeta(ctx: ExtensionContext): Json {
    return {
      name: pi.getSessionName() ?? null,
      cwd: ctx.cwd,
      host: hostname(),
      spawn: spawner.enabled ? { ...spawner.capability(), cwd: ctx.cwd } : null,
    };
  }

  function snapshot(ctx: ExtensionContext): Json {
    const entries = ctx.sessionManager.getEntries() as unknown as Json[];
    sentIds = entries.map((entry) => String(entry.id));
    return { entries, status: buildStatus(ctx), meta: buildMeta(ctx), leafId: ctx.sessionManager.getLeafId() ?? null };
  }

  function syncEntries(ctx: ExtensionContext): void {
    if (!bridge?.session) return;
    const entries = ctx.sessionManager.getEntries() as unknown as Json[];
    let rewrite = entries.length < sentIds.length;
    if (!rewrite) {
      for (let i = 0; i < sentIds.length; i += 1) {
        if (String(entries[i]?.id) !== sentIds[i]) {
          rewrite = true;
          break;
        }
      }
    }
    if (rewrite) {
      sentIds = entries.map((entry) => String(entry.id));
      safe(() => bridge?.publishRebase(entries, ctx.sessionManager.getLeafId() ?? null));
      return;
    }
    const seen = new Set(sentIds);
    const fresh = entries.filter((entry) => !seen.has(String(entry.id)));
    if (fresh.length === 0) return;
    sentIds.push(...fresh.map((entry) => String(entry.id)));
    safe(() => bridge?.publishEntries(fresh));
  }

  function safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* not connected */
    }
  }

  function registerSession(ctx: ExtensionContext): void {
    if (!bridge || !ctx) {
      trace("registerSession skipped", `bridge=${Boolean(bridge)} ctx=${Boolean(ctx)}`);
      return;
    }
    try {
      spawner.cwd = ctx.cwd;
      void detectGit(ctx.cwd).then((isGit) => {
        spawner.git = isGit;
      });
      sessionId = ctx.sessionManager.getSessionId();
      bridge.setSnapshotProvider(() => snapshot(ctx));
      bridge.openSession({ sessionId, meta: buildMeta(ctx) });
      trace("registerSession", sessionId);
      safe(() => bridge?.publishSnapshot(snapshot(ctx)));
      safe(() => bridge?.publishStatus(buildStatus(ctx)));
    } catch (error) {
      sessionId = undefined;
      reportError("registerSession", error);
    }
  }

  // -- commands from controllers --------------------------------------------

  async function handleCommand({ op, args }: { op: string; args: Json }): Promise<{ accepted: boolean; mode: string | null; error?: string | null; data?: Json | null }> {
    const ctx = activeCtx;
    if (!ctx) return { accepted: false, mode: null, error: "no_active_session" };
    switch (op) {
      case "prompt": {
        const text = String(args.text ?? "");
        if (!text) return { accepted: false, mode: null, error: "empty_prompt" };
        const { deliverAs, mode } = resolveDelivery({ isIdle: ctx.isIdle(), requested: typeof args.deliverAs === "string" ? args.deliverAs : undefined });
        const images = Array.isArray(args.images) ? (args.images as never[]) : undefined;
        const content = images ? ([{ type: "text", text }, ...images] as never) : text;
        if (deliverAs) pi.sendUserMessage(content, { deliverAs: deliverAs as never });
        else pi.sendUserMessage(content);
        return { accepted: true, mode };
      }
      case "abort":
        ctx.abort();
        return { accepted: true, mode: "immediate" };
      case "compact":
        ctx.compact(args.instructions ? { customInstructions: String(args.instructions) } : undefined);
        return { accepted: true, mode: "immediate" };
      case "set_model": {
        const model = ctx.modelRegistry.find(String(args.provider ?? ""), String(args.modelId ?? ""));
        if (!model) return { accepted: false, mode: null, error: "model_not_found" };
        const ok = await pi.setModel(model);
        return { accepted: ok, mode: "immediate", error: ok ? null : "auth_unavailable" };
      }
      case "list_models": {
        // Session-scoped models when configured, otherwise everything the
        // registry has auth for. Sent in the ack (models aren't secret).
        const scoped = ctx.scopedModels ?? [];
        const source = scoped.length > 0 ? scoped.map((entry: { model: never }) => entry.model) : ctx.modelRegistry.getAvailable();
        const seen = new Set<string>();
        const models: Json[] = [];
        for (const model of source as unknown as { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number }[]) {
          const key = `${String(model.provider)}/${String(model.id)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          let providerName = String(model.provider);
          try {
            providerName = ctx.modelRegistry.getProviderDisplayName(model.provider) || providerName;
          } catch {
            /* display name is optional */
          }
          models.push({
            provider: String(model.provider),
            id: String(model.id),
            name: String(model.name ?? model.id),
            providerName,
            reasoning: Boolean(model.reasoning),
            contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : null,
          });
        }
        models.sort(
          (a, b) =>
            String(a.providerName).localeCompare(String(b.providerName)) || String(a.name).localeCompare(String(b.name)),
        );
        return {
          accepted: true,
          mode: "immediate",
          data: {
            models,
            current: ctx.model ? { provider: String(ctx.model.provider), id: String(ctx.model.id) } : null,
          },
        };
      }
      case "set_thinking":
        pi.setThinkingLevel(String(args.level ?? "off") as never);
        return { accepted: true, mode: "immediate" };
      case "rename":
        pi.setSessionName(String(args.name ?? ""));
        return { accepted: true, mode: "immediate" };
      case "spawn": {
        const result = spawner.spawn({ name: typeof args.name === "string" ? args.name : undefined });
        if (!result.ok) return { accepted: false, mode: null, error: result.error };
        safe(() => bridge?.publishMeta(buildMeta(ctx)));
        return {
          accepted: true,
          mode: "immediate",
          data: { sessionId: result.sessionId, name: result.name, pid: result.pid ?? null },
        };
      }
      default:
        return { accepted: false, mode: null, error: `unknown_op:${op}` };
    }
  }

  // -- connection -----------------------------------------------------------

  async function connectBridge(force = false): Promise<void> {
    if (bridge) {
      if (!force) return;
      try {
        bridge.close();
      } catch {
        /* ignore */
      }
      bridge = undefined;
    }
    const state = loadHostState(dir);
    if (!state.hostId || !state.identity || !state.encryption) throw new Error("host is not enrolled");
    const hostBridge = new HostBridge({
      url: hubUrl,
      deviceId: state.hostId,
      identity: state.identity as never,
      encryption: state.encryption as never,
      hostName: hostname(),
      agent: { name: "pi", version: "unknown" },
    });
    hostBridge.onCommand((command) => queue.run(() => handleCommand(command)));
    hostBridge.on("disconnected", () => {
      pi.events.emit("pinet:status", { connected: false, reason: "disconnected" });
    });
    hostBridge.on("reconnected", () => {
      pi.events.emit("pinet:status", { connected: true, reason: "reconnected" });
      if (activeCtx && !sessionId) registerSession(activeCtx);
    });
    hostBridge.on("closed", () => {
      pi.events.emit("pinet:status", { connected: false, reason: "closed" });
    });
    await hostBridge.connect();
    trace("bridge connected", `activeCtx=${Boolean(activeCtx)} sessionId=${sessionId ?? "-"}`);
    // Server-side error frames (rejected sessions, internal errors) are otherwise
    // dropped silently by the socket client.
    hostBridge.socket?.on("error", (data: unknown) => reportError("hub", JSON.stringify(data)));
    hostBridge.on("reconnecting", (info: { delayMs: number }) => pi.events.emit("pinet:status", { connected: false, reason: `reconnecting in ${Math.round(info.delayMs / 1000)}s` }));
    bridge = hostBridge;
    if (activeCtx && !sessionId) registerSession(activeCtx);
  }

  async function autoStart(): Promise<void> {
    trace("autoStart");
    try {
      const state = loadHostState(dir);
      if (state.hostId && state.identity && state.encryption) {
        await connectBridge();
        return;
      }
      if (enrollCode) {
        const keys = ensureHostKeys(dir);
        const { hostId, fingerprint } = await enrollHostWithCode({
          httpUrl,
          code: enrollCode,
          name: hostname(),
          identity: keys.identity,
          encryption: keys.encryption,
        });
        saveHostState(dir, { hostId, fingerprint, identity: keys.identity, encryption: keys.encryption });
        await connectBridge();
        return;
      }
    } catch (error) {
      reportError("autoStart", error);
    }
  }

  // -- /pinet command -------------------------------------------------------

  pi.registerCommand("pinet", {
    description: "Pinet remote control: /pinet setup | status | reconnect | logout",
    handler: async (args, ctx) => {
      const sub = (args.trim().split(/\s+/)[0] || "status").toLowerCase();
      const state = loadHostState(dir);

      if (sub === "status") {
        const lines = [
          `hub: ${hubUrl}`,
          `connected: ${Boolean(bridge?.socket?.ready)}`,
          `host: ${state.hostId ?? "(not enrolled)"}`,
          `session: ${sessionId ?? "(none)"}`,
        ];
        notify(ctx, lines.join("\n"), state.hostId ? "info" : "warning");
        return;
      }

      if (sub === "logout") {
        safe(() => bridge?.closeSession("logout"));
        bridge?.close();
        bridge = undefined;
        clearHostState(dir);
        notify(ctx, "Pinet: host identity cleared.", "warning");
        return;
      }

      if (sub === "reconnect") {
        bridge?.close();
        bridge = undefined;
        try {
          await connectBridge();
          notify(ctx, "Pinet: reconnected.", "info");
        } catch (error) {
          notify(ctx, `Pinet: ${String((error as Error)?.message ?? error)}`, "error");
        }
        return;
      }

      if (sub === "setup") {
        try {
          // Idempotent: if already enrolled, just reconnect with the stored
          // identity instead of creating another device.
          if (state.hostId) {
            await connectBridge(true);
            notify(ctx, `Pinet: already set up as ${state.hostId}`, "info");
            return;
          }
          const result = await onboardHost({
            httpUrl,
            dir,
            name: hostname(),
            onCode: ({ userCode, verificationUri }) => {
              notify(ctx, `Pinet setup\n\n1. Open: ${verificationUri}\n2. Sign in (Google + MFA)\n3. Enter code: ${userCode}`, "info");
              openUrl(verificationUri);
            },
          });
          await connectBridge(true);
          notify(ctx, `Pinet: enrolled as ${result.hostId}\nFingerprint: ${String(result.fingerprint).slice(0, 16)}`, "info");
        } catch (error) {
          notify(ctx, `Pinet setup failed: ${String((error as Error)?.message ?? error)}`, "error");
        }
        return;
      }

      notify(ctx, "Usage: /pinet setup | status | reconnect | logout", "warning");
    },
  });

  // -- events ---------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    trace("session_start", `bridge=${Boolean(bridge)} sessionId=${sessionId ?? "-"}`);
    activeCtx = ctx;
    if (bridge && !sessionId) registerSession(ctx);
  });

  pi.on("session_shutdown", async () => {
    safe(() => bridge?.closeSession("shutdown"));
    spawner.shutdown();
    activeCtx = undefined;
    sessionId = undefined;
    sentIds = [];
  });

  // NOTE: pi passes a fresh ExtensionContext object to each event handler, so
  // handlers must never compare `ctx` by identity. Each event's ctx is used
  // directly (one active session per process); activeCtx is only a hint for
  // bridge callbacks that run outside an event.
  pi.on("message_end", async (_event, ctx) => {
    activeCtx = ctx;
    syncEntries(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    activeCtx = ctx;
    syncEntries(ctx);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    activeCtx = ctx;
    runningTools.set(event.toolCallId, { toolName: event.toolName, args: event.args });
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    activeCtx = ctx;
    runningTools.delete(event.toolCallId);
    syncEntries(ctx);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeCtx = ctx;
    runCounter += 1;
    currentRun = { id: `run_${Date.now().toString(36)}_${runCounter.toString(36)}`, startedAt: Date.now() };
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    activeCtx = ctx;
    currentRun = undefined;
    runningTools.clear();
    syncEntries(ctx);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("model_select", async (_event, ctx) => {
    activeCtx = ctx;
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    activeCtx = ctx;
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    activeCtx = ctx;
    safe(() => bridge?.publishMeta(buildMeta(ctx)));
  });

  pi.on("session_before_compact", async (event, ctx) => {
    activeCtx = ctx;
    compacting = { reason: event.reason ?? "manual" };
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("session_compact", async (_event, ctx) => {
    activeCtx = ctx;
    compacting = undefined;
    safe(() => bridge?.publishRebase(ctx.sessionManager.getEntries() as unknown as Json[], ctx.sessionManager.getLeafId() ?? null));
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("session_compact_failed", async (_event, ctx) => {
    activeCtx = ctx;
    compacting = undefined;
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("session_tree", async (_event, ctx) => {
    activeCtx = ctx;
    safe(() => bridge?.publishRebase(ctx.sessionManager.getEntries() as unknown as Json[], ctx.sessionManager.getLeafId() ?? null));
  });

  void autoStart();
  trace("extension loaded");
}
