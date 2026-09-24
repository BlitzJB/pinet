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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostBridge } from "../src/host/bridge.mjs";
import { createSerialQueue } from "../src/host/command-queue.mjs";
import { resolveDelivery } from "../src/host/delivery.mjs";
import { clearHostState, ensureHostKeys, enrollHostWithCode, loadHostState, onboardHost, saveHostState } from "../src/host/onboarding.mjs";

type Json = Record<string, unknown>;
type Pi = ExtensionAPI;

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

  function setStatus(ctx: ExtensionContext | undefined, text: string | undefined): void {
    try {
      ctx?.ui.setStatus("pinet", text);
    } catch {
      /* no UI */
    }
  }

  function notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
      ctx?.ui.notify(message, type);
    } catch {
      /* no UI */
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
    };
  }

  function buildMeta(ctx: ExtensionContext): Json {
    return { name: pi.getSessionName() ?? null, cwd: ctx.cwd, host: hostname() };
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
    if (!bridge || !ctx) return;
    sessionId = ctx.sessionManager.getSessionId();
    bridge.setSnapshotProvider(() => snapshot(ctx));
    bridge.openSession({ sessionId, meta: buildMeta(ctx) });
    safe(() => bridge?.publishSnapshot(snapshot(ctx)));
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  }

  // -- commands from controllers --------------------------------------------

  async function handleCommand({ op, args }: { op: string; args: Json }): Promise<{ accepted: boolean; mode: string | null; error?: string | null }> {
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
      case "set_thinking":
        pi.setThinkingLevel(String(args.level ?? "off") as never);
        return { accepted: true, mode: "immediate" };
      case "rename":
        pi.setSessionName(String(args.name ?? ""));
        return { accepted: true, mode: "immediate" };
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
      setStatus(activeCtx, "pinet: reconnecting…");
      pi.events.emit("pinet:status", { connected: false, reason: "disconnected" });
    });
    hostBridge.on("reconnecting", (info: { delayMs: number }) => setStatus(activeCtx, `pinet: reconnecting in ${Math.round(info.delayMs / 1000)}s`));
    hostBridge.on("reconnected", () => {
      setStatus(activeCtx, "pinet: connected");
      pi.events.emit("pinet:status", { connected: true, reason: "reconnected" });
      if (activeCtx && !sessionId) registerSession(activeCtx);
    });
    hostBridge.on("closed", () => {
      setStatus(activeCtx, "pinet: disconnected");
      pi.events.emit("pinet:status", { connected: false, reason: "closed" });
    });
    await hostBridge.connect();
    bridge = hostBridge;
    setStatus(activeCtx, "pinet: connected");
    if (activeCtx && !sessionId) registerSession(activeCtx);
  }

  async function autoStart(): Promise<void> {
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
      setStatus(activeCtx, "pinet: not set up — run /pinet setup");
    } catch (error) {
      setStatus(activeCtx, `pinet: error — ${String((error as Error)?.message ?? error)}`);
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
        setStatus(ctx, "pinet: logged out");
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
            setStatus(ctx, "pinet: reconnecting…");
            await connectBridge(true);
            notify(ctx, `Pinet: already set up as ${state.hostId}`, "info");
            return;
          }
          setStatus(ctx, "pinet: waiting for browser approval…");
          const result = await onboardHost({
            httpUrl,
            dir,
            name: hostname(),
            onCode: ({ userCode, verificationUri }) => {
              notify(ctx, `Pinet setup\n\n1. Open: ${verificationUri}\n2. Sign in (Google + MFA)\n3. Enter code: ${userCode}`, "info");
              openUrl(verificationUri);
            },
            onTick: () => setStatus(ctx, "pinet: waiting for browser approval…"),
          });
          setStatus(ctx, "pinet: connecting…");
          await connectBridge(true);
          notify(ctx, `Pinet: enrolled as ${result.hostId}\nFingerprint: ${String(result.fingerprint).slice(0, 16)}`, "info");
        } catch (error) {
          setStatus(ctx, "pinet: setup failed");
          notify(ctx, `Pinet setup failed: ${String((error as Error)?.message ?? error)}`, "error");
        }
        return;
      }

      notify(ctx, "Usage: /pinet setup | status | reconnect | logout", "warning");
    },
  });

  // -- events ---------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (bridge && !sessionId) registerSession(ctx);
    else if (!bridge) setStatus(ctx, "pinet: not connected");
  });

  pi.on("session_shutdown", async () => {
    safe(() => bridge?.closeSession("shutdown"));
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
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    activeCtx = ctx;
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

  pi.on("session_compact", async (_event, ctx) => {
    activeCtx = ctx;
    safe(() => bridge?.publishRebase(ctx.sessionManager.getEntries() as unknown as Json[], ctx.sessionManager.getLeafId() ?? null));
  });

  pi.on("session_tree", async (_event, ctx) => {
    activeCtx = ctx;
    safe(() => bridge?.publishRebase(ctx.sessionManager.getEntries() as unknown as Json[], ctx.sessionManager.getLeafId() ?? null));
  });

  void autoStart();
}
