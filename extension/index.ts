/**
 * PiNet host extension.
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
import { HISTORY_PAGE_SIZE, INITIAL_ENTRY_LIMIT, historyWindow } from "../src/host/history.mjs";

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
  // pi-subagents marks child processes with PI_SUBAGENT_CHILD=1. A child is part
  // of a parent's run, not an independent host: connecting would register a
  // throwaway session per child (sidebar noise, extra host connection, extra
  // key wraps). Children are surfaced through the parent instead.
  const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";

  let bridge: HostBridge | undefined;
  let activeCtx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let sentIds: string[] = [];
  const runningTools = new Map<string, { toolName: string; args: unknown }>();
  const queue = createSerialQueue();
  let currentRun: { id: string; startedAt: number } | undefined;
  let compacting: { reason: string } | undefined;
  let compactingSince = 0;
  let runCounter = 0;

  // pi emits `session_compact` while its run loop is still settling, so a status
  // read there reports "running" even though no run is in flight. Status is
  // otherwise only pushed on a fixed set of events, so nothing would ever correct
  // it and the controller would show a status line forever (the bug we hit:
  // compaction completed, the indicator kept spinning). So nudge status until pi
  // reports idle, and keep a slow heartbeat for the life of any run so a dropped
  // frame cannot strand the UI either. Intervals are env-tunable for tests.
  const SETTLE_MS = Number(process.env.PINET_STATUS_SETTLE_MS ?? 750);
  const SETTLE_MAX_MS = Number(process.env.PINET_STATUS_SETTLE_MAX_MS ?? 45_000);
  const HEARTBEAT_MS = Number(process.env.PINET_STATUS_HEARTBEAT_MS ?? 10_000);
  const COMPACT_STALE_MS = Number(process.env.PINET_COMPACT_STALE_MS ?? 900_000);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

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

  /** Publish the live status once (no-op without a session). */
  function publishStatus(): void {
    const ctx = activeCtx;
    if (!ctx) return;
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  }

  function setCompacting(next: { reason: string } | undefined): void {
    compacting = next;
    compactingSince = next ? Date.now() : 0;
  }

  function stopStatusHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  /**
   * Re-publish status every few seconds while a run or compaction is in flight.
   * It stops as soon as pi is idle, so an idle session stays silent; the point is
   * that a controller can never be left holding a stale "running" forever.
   */
  function startStatusHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      // A compaction flag that outlives any plausible summarization means the
      // matching `session_compact*` event never arrived: stop reporting it.
      if (compacting && Date.now() - compactingSince > COMPACT_STALE_MS) setCompacting(undefined);
      const ctx = activeCtx;
      if (!ctx || (ctx.isIdle() && !compacting)) {
        stopStatusHeartbeat();
        publishStatus();
        return;
      }
      publishStatus();
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  /**
   * Re-publish status until pi reports idle. `session_compact` fires before the
   * run loop settles, so the status published there can still say "running";
   * without this the controller has no way to learn otherwise.
   */
  function settleStatus(): void {
    if (settleTimer) clearTimeout(settleTimer);
    const deadline = Date.now() + SETTLE_MAX_MS;
    const tick = (): void => {
      settleTimer = undefined;
      publishStatus();
      const ctx = activeCtx;
      if (!ctx || (ctx.isIdle() && !compacting) || Date.now() > deadline) return;
      settleTimer = setTimeout(tick, SETTLE_MS);
      settleTimer.unref?.();
    };
    settleTimer = setTimeout(tick, SETTLE_MS);
    settleTimer.unref?.();
  }

  // Transcript paging: a long session (multi-MB JSONL) must not be shipped in one
  // snapshot. See src/host/history.mjs for the window arithmetic.
  function windowed(entries: Json[], limit = INITIAL_ENTRY_LIMIT): { entries: Json[]; history: Json } {
    const window = historyWindow(entries.length, entries.length, limit);
    return {
      entries: entries.slice(window.start, window.end),
      history: { cursor: window.cursor, hasMore: window.hasMore, total: window.total },
    };
  }

  function snapshot(ctx: ExtensionContext): Json {
    const entries = ctx.sessionManager.getEntries() as unknown as Json[];
    // `sentIds` still tracks every entry so delta sync stays exact; only the
    // frame is trimmed to the tail.
    sentIds = entries.map((entry) => String(entry.id));
    const { entries: tail, history } = windowed(entries);
    return {
      entries: tail,
      history,
      status: buildStatus(ctx),
      meta: buildMeta(ctx),
      leafId: ctx.sessionManager.getLeafId() ?? null,
    };
  }

  /**
   * A rebase replaces the controller's transcript wholesale (compaction, branch
   * switch, history rewrite). It ships the same windowed shape as a snapshot so
   * it can neither re-inflate a multi-MB session nor bypass paging: a compaction
   * of a 9 MB session used to fan out all 2533 raw entries.
   */
  function publishRebase(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries() as unknown as Json[];
    sentIds = entries.map((entry) => String(entry.id));
    const { entries: tail, history } = windowed(entries);
    safe(() => bridge?.publishRebase(tail, history, ctx.sessionManager.getLeafId() ?? null));
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
      publishRebase(ctx);
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

  /**
   * Record the active context for every event. pi does not guarantee that
   * `session_start` is delivered after our handlers are registered (extensions
   * load asynchronously, and a large session can start first), so any event can
   * be the one that finally lets us register the session.
   */
  function adopt(ctx: ExtensionContext): void {
    activeCtx = ctx;
    if (bridge && !sessionId) registerSession(ctx);
  }

  function registerSession(ctx: ExtensionContext): void {
    if (!bridge || !ctx) {
      trace("registerSession skipped", `bridge=${Boolean(bridge)} ctx=${Boolean(ctx)}`);
      return;
    }
    // Events often arrive before the socket finishes its handshake; that is a
    // normal "not yet", not a failure — adopt() retries on the next event.
    if (!bridge.socket?.ready) {
      trace("registerSession deferred", "socket not ready");
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
      case "history": {
        // Older entries for the transcript. The page is published as an encrypted
        // `session.page` frame; the ack only carries the resulting cursor.
        const entries = ctx.sessionManager.getEntries() as unknown as Json[];
        const before = typeof args.before === "number" ? args.before : entries.length;
        const requested = typeof args.limit === "number" ? args.limit : HISTORY_PAGE_SIZE;
        const limit = Math.min(Math.max(1, requested), 500);
        const window = historyWindow(entries.length, before, limit);
        const history = { cursor: window.cursor, hasMore: window.hasMore, total: window.total };
        safe(() => bridge?.publishPage(entries.slice(window.start, window.end), history, ctx.sessionManager.getLeafId() ?? null));
        return { accepted: true, mode: "immediate", data: { ...history, returned: window.end - window.start } };
      }
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
    // Publish the bridge immediately: a slow handshake must not leave the
    // extension bridgeless, or nothing would ever register the session.
    bridge = hostBridge;
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
    try {
      await hostBridge.connect();
    } catch (error) {
      // Keep the bridge: the socket retries and registration self-heals via adopt().
      reportError("connectBridge", error);
      return;
    }
    trace("bridge connected", `activeCtx=${Boolean(activeCtx)} sessionId=${sessionId ?? "-"}`);
    // Server-side error frames (rejected sessions, internal errors) are otherwise
    // dropped silently by the socket client.
    hostBridge.socket?.on("error", (data: unknown) => reportError("hub", JSON.stringify(data)));
    hostBridge.on("reconnecting", (info: { delayMs: number }) => pi.events.emit("pinet:status", { connected: false, reason: `reconnecting in ${Math.round(info.delayMs / 1000)}s` }));
    if (activeCtx && !sessionId) registerSession(activeCtx);
  }

  async function autoStart(): Promise<void> {
    if (isSubagentChild) {
      // Deliberately inert: see the PI_SUBAGENT_CHILD note above.
      trace("subagent child: pinet host disabled");
      return;
    }
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
    description: "PiNet remote control: /pinet setup | status | reconnect | logout",
    handler: async (args, ctx) => {
      const sub = (args.trim().split(/\s+/)[0] || "status").toLowerCase();
      const state = loadHostState(dir);

      if (sub === "status") {
        const lines = [
          `hub: ${hubUrl}`,
          `connected: ${Boolean(bridge?.socket?.ready)}`,
          `host: ${state.hostId ?? "(not enrolled)"}`,
          `session: ${sessionId ?? "(none)"}`,
          ...(isSubagentChild ? ["subagent child: pinet host disabled for this process"] : []),
        ];
        notify(ctx, lines.join("\n"), state.hostId ? "info" : "warning");
        return;
      }

      if (sub === "logout") {
        safe(() => bridge?.closeSession("logout"));
        bridge?.close();
        bridge = undefined;
        clearHostState(dir);
        notify(ctx, "PiNet: host identity cleared.", "warning");
        return;
      }

      if (sub === "reconnect") {
        bridge?.close();
        bridge = undefined;
        try {
          await connectBridge();
          notify(ctx, "PiNet: reconnected.", "info");
        } catch (error) {
          notify(ctx, `PiNet: ${String((error as Error)?.message ?? error)}`, "error");
        }
        return;
      }

      if (sub === "setup") {
        try {
          // Idempotent: if already enrolled, just reconnect with the stored
          // identity instead of creating another device.
          if (state.hostId) {
            await connectBridge(true);
            notify(ctx, `PiNet: already set up as ${state.hostId}`, "info");
            return;
          }
          const result = await onboardHost({
            httpUrl,
            dir,
            name: hostname(),
            onCode: ({ userCode, verificationUri }) => {
              notify(ctx, `PiNet setup\n\n1. Open: ${verificationUri}\n2. Sign in (Google + MFA)\n3. Enter code: ${userCode}`, "info");
              openUrl(verificationUri);
            },
          });
          await connectBridge(true);
          notify(ctx, `PiNet: enrolled as ${result.hostId}\nFingerprint: ${String(result.fingerprint).slice(0, 16)}`, "info");
        } catch (error) {
          notify(ctx, `PiNet setup failed: ${String((error as Error)?.message ?? error)}`, "error");
        }
        return;
      }

      notify(ctx, "Usage: /pinet setup | status | reconnect | logout", "warning");
    },
  });

  // -- events ---------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    trace("session_start", `bridge=${Boolean(bridge)} sessionId=${sessionId ?? "-"}`);
    adopt(ctx);
    if (bridge && !sessionId) registerSession(ctx);
  });

  pi.on("session_shutdown", async () => {
    safe(() => bridge?.closeSession("shutdown"));
    spawner.shutdown();
    stopStatusHeartbeat();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = undefined;
    activeCtx = undefined;
    sessionId = undefined;
    sentIds = [];
  });

  // NOTE: pi passes a fresh ExtensionContext object to each event handler, so
  // handlers must never compare `ctx` by identity. Each event's ctx is used
  // directly (one active session per process); activeCtx is only a hint for
  // bridge callbacks that run outside an event.
  pi.on("message_end", async (_event, ctx) => {
    adopt(ctx);
    syncEntries(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    adopt(ctx);
    syncEntries(ctx);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    adopt(ctx);
    runningTools.set(event.toolCallId, { toolName: event.toolName, args: event.args });
    startStatusHeartbeat();
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    adopt(ctx);
    runningTools.delete(event.toolCallId);
    syncEntries(ctx);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("agent_start", async (_event, ctx) => {
    adopt(ctx);
    runCounter += 1;
    currentRun = { id: `run_${Date.now().toString(36)}_${runCounter.toString(36)}`, startedAt: Date.now() };
    startStatusHeartbeat();
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    adopt(ctx);
    currentRun = undefined;
    runningTools.clear();
    syncEntries(ctx);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("model_select", async (_event, ctx) => {
    adopt(ctx);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    adopt(ctx);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    adopt(ctx);
    safe(() => bridge?.publishMeta(buildMeta(ctx)));
  });

  pi.on("session_before_compact", async (event, ctx) => {
    adopt(ctx);
    setCompacting({ reason: event.reason ?? "manual" });
    startStatusHeartbeat();
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
  });

  pi.on("session_compact", async (_event, ctx) => {
    adopt(ctx);
    setCompacting(undefined);
    publishRebase(ctx);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
    settleStatus();
  });

  pi.on("session_compact_failed", async (_event, ctx) => {
    adopt(ctx);
    setCompacting(undefined);
    safe(() => bridge?.publishStatus(buildStatus(ctx)));
    settleStatus();
  });

  pi.on("session_tree", async (_event, ctx) => {
    adopt(ctx);
    publishRebase(ctx);
  });

  void autoStart();
  trace("extension loaded");
}
