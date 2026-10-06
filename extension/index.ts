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

import { spawn as spawnProcess } from "node:child_process";
import { hostname } from "node:os";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostBridge } from "../src/host/bridge.mjs";
import { createSerialQueue } from "../src/host/command-queue.mjs";
import { resolveDelivery } from "../src/host/delivery.mjs";
import { clearHostState, ensureHostKeys, enrollHostWithCode, loadHostState, onboardHost, saveHostState } from "../src/host/onboarding.mjs";
import { SessionSpawner, detectGit, detectTmux } from "../src/host/spawner.mjs";
import { HISTORY_PAGE_SIZE, INITIAL_ENTRY_LIMIT, historyWindow } from "../src/host/history.mjs";
import { DEFAULT_POLICIES, VoicePipeline, VoiceSpool, createCleaner, createTranscriber, resolveApiKey } from "../src/host/voice.mjs";
import { commandCatalogue, filterPaths, resolveCommand, tuiOnlyNotice, walkFiles } from "../src/host/commands.mjs";
import {
  buildContentParts,
  createAttachmentStore,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from "../src/host/attachments.mjs";

/** How long a directory listing is reused before it is walked again. */
const FILES_CACHE_MS = 5_000;

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
  // When pi last reported the agent settled. This is the signal that a run is
  // *finished*, as opposed to merely between turns, and it is what the controller
  // uses to decide a session is worth summarising — no guessing with timers.
  let lastSettledAt = 0;
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

  // Voice dictation (see src/host/voice.mjs). Audio arrives as sealed chunks on
  // the existing attachment and is held in memory only — never written to disk —
  // and the finished text goes back sealed, so the coordinator sees neither. The
  // cleanup policy is prompt-side; this only bounds and forwards.
  const voiceTerms = (): string[] => {
    const extra = (process.env.PINET_VOICE_TERMS ?? "")
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean);
    return [...new Set([...DEFAULT_POLICIES.terms, ...extra])];
  };
  const voiceApiKey = resolveApiKey({
    readAuth: () => JSON.parse(readFileSync(`${process.env.HOME ?? "."}/.pi/agent/auth.json`, "utf8")) as Record<string, { key?: string }>,
  });
  const voicePipeline =
    process.env.PINET_VOICE === "off" || !voiceApiKey
      ? undefined
      : new VoicePipeline({
          transcriber: createTranscriber({
            apiKey: voiceApiKey,
            model: process.env.PINET_VOICE_ASR_MODEL,
            baseUrl: process.env.PINET_VOICE_ASR_URL,
          }),
          cleaner: createCleaner({
            apiKey: voiceApiKey,
            model: process.env.PINET_VOICE_LLM_MODEL,
            baseUrl: process.env.PINET_VOICE_LLM_URL,
          }),
          policies: { ...DEFAULT_POLICIES, terms: voiceTerms() },
        });
  // Every take is written here before a provider is called, so a failure costs a
  // retry rather than the recording. Stays on this machine; bounded and pruned.
  const voiceSpool =
    process.env.PINET_VOICE_SPOOL === "off"
      ? undefined
      : new VoiceSpool({
          dir: process.env.PINET_VOICE_SPOOL_DIR ?? `${dir}/voice`,
          maxTakes: Number(process.env.PINET_VOICE_SPOOL_MAX ?? 20),
        });
  // One session per process, so one buffer. ~250ms chunks; the pipeline's byte
  // limit is the real bound (ten minutes), this just stops the array growing
  // without limit if frames arrive after a take ends.
  let audioChunks: { index: number; data: string }[] = [];
  const MAX_AUDIO_CHUNKS = 4096;

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
      settledAt: lastSettledAt || null,
      compacting: compacting ? { reason: compacting.reason } : null,
    };
  }

  function buildMeta(ctx: ExtensionContext): Json {
    return {
      name: pi.getSessionName() ?? null,
      cwd: ctx.cwd,
      host: hostname(),
      voice: voicePipeline?.enabled ? { enabled: true } : null,
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

  // Attachments this machine has been sent. Metadata is stripped and the file name is
  // generated on the way in, so nothing here is shaped by a client.
  const attachmentStore = createAttachmentStore();

  // -- commands from controllers --------------------------------------------

  async function handleCommand({ op, args }: { op: string; args: Json }): Promise<{ accepted: boolean; mode: string | null; error?: string | null; data?: Json | null }> {
    const ctx = activeCtx;
    if (!ctx) return { accepted: false, mode: null, error: "no_active_session" };
    switch (op) {
      case "prompt": {
        const text = String(args.text ?? "");
        const attachedIds = Array.isArray(args.attachments) ? (args.attachments as { id?: string }[]) : [];
        // An image with no words is a legitimate message, so text is only required
        // when there is nothing attached.
        if (!text && attachedIds.length === 0) return { accepted: false, mode: null, error: "empty_prompt" };
        // A message starting with a slash is resolved here rather than in the client,
        // so every controller behaves the same way. Commands pi expands itself pass
        // through untouched; the ones with a session API become that op; the
        // terminal-only ones are refused with a reason instead of silently doing
        // nothing. An unknown `/foo` — and a path like `/root/pinet` — is left alone.
        const resolved = resolveCommand(text, { commands: pi.getCommands() as never });
        if (resolved.kind === "portal") {
          const rewrite = rewritePortalCommand(resolved.name, resolved.args, ctx);
          if (rewrite.refuse) {
            return { accepted: false, mode: null, error: rewrite.error, data: { notice: rewrite.refuse } };
          }
          if (rewrite.op) return handleCommand({ op: rewrite.op, args: { ...args, ...rewrite.args } });
        } else if (resolved.kind === "tui-only") {
          return { accepted: false, mode: null, error: "tui_only", data: { notice: tuiOnlyNotice(resolved.name) } };
        }
        const { deliverAs, mode } = resolveDelivery({ isIdle: ctx.isIdle(), requested: typeof args.deliverAs === "string" ? args.deliverAs : undefined });
        const images = Array.isArray(args.images) ? (args.images as never[]) : undefined;
        let content: unknown = images ? ([{ type: "text", text }, ...images] as never) : text;
        if (attachedIds.length > 0) {
          if (attachedIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
            return { accepted: false, mode: null, error: "too_many_attachments" };
          }
          const resolved = attachedIds
            .map((entry) => attachmentStore.read(entry?.id))
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
          if (resolved.length !== attachedIds.length) return { accepted: false, mode: null, error: "attachment_not_found" };
          const total = resolved.reduce((sum, entry) => sum + entry.size, 0);
          if (total > MAX_ATTACHMENT_TOTAL_BYTES) return { accepted: false, mode: null, error: "attachments_too_large" };
          content = buildContentParts({
            text,
            attachments: resolved.map((entry) => ({
              name: entry.name,
              mime: entry.mime,
              kind: entry.kind,
              data: entry.data,
              text: entry.kind === "text" ? entry.bytes.toString("utf8") : "",
            })),
          }) as never;
        }
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
      case "attach.begin": {
        const started = attachmentStore.begin({ name: args.name, mime: args.mime, size: args.size });
        return started.error
          ? { accepted: false, mode: null, error: started.error }
          : { accepted: true, mode: null, data: started };
      }
      case "attach.chunk": {
        // Base64 inside an ordinary sealed command: the security properties come from
        // the command envelope, and the chunk size keeps it under the hub's frame cap.
        const result = attachmentStore.chunk({ id: args.id, index: args.index, data: args.data });
        return result.error ? { accepted: false, mode: null, error: result.error } : { accepted: true, mode: null, data: { received: result.received } };
      }
      case "attach.end": {
        const record = attachmentStore.end({ id: args.id });
        if (record.error) return { accepted: false, mode: null, error: record.error };
        return {
          accepted: true,
          mode: null,
          data: { attachment: { id: record.id, name: record.name, mime: record.mime, size: record.size, kind: record.kind } },
        };
      }
      case "attachments.list":
        return { accepted: true, mode: null, data: { attachments: attachmentStore.list() } };
      case "attachment.get": {
        // For a controller that did not send it: another device, or this one after a
        // reload. The bytes go back encrypted like everything else.
        const found = attachmentStore.read(args.id);
        if (!found) return { accepted: false, mode: null, error: "not_found" };
        return {
          accepted: true,
          mode: null,
          data: {
            attachment: { id: found.id, name: found.name, mime: found.mime, size: found.size, kind: found.kind },
            data: found.data,
          },
        };
      }
      case "commands":
        // What the composer offers. Sent encrypted like everything else that
        // describes a session's contents.
        return { accepted: true, mode: null, data: { commands: commandCatalogue({ commands: pi.getCommands() as never }) } };
      case "files": {
        // Completion for `@` mentions, scoped to this session's own directory and
        // bounded: it feeds a picker, not a file browser.
        const cwd = ctx.sessionManager.getCwd();
        const prefix = typeof args.prefix === "string" ? args.prefix : "";
        const limit = Math.min(Math.max(1, Number(args.limit) || 40), 200);
        return { accepted: true, mode: null, data: { files: filterPaths(cachedWalk(cwd), prefix, limit), cwd } };
      }
      case "set_thinking":
        pi.setThinkingLevel(String(args.level ?? "off") as never);
        return { accepted: true, mode: "immediate" };
      case "voice.start":
      case "voice.cancel":
        takeAudio();
        return { accepted: true, mode: null };
      case "voice.retry": {
        if (!voiceSpool?.enabled) return { accepted: false, mode: null, error: "no_spool" };
        void retryVoice(ctx, typeof args.id === "string" ? args.id : undefined);
        return { accepted: true, mode: null };
      }
      case "voice.end": {
        // Fire-and-forget from the caller's perspective: the transcript arrives
        // as a sealed `session.voice` frame, never in this (plaintext) ack.
        if (!voicePipeline?.enabled) return { accepted: false, mode: null, error: "voice_disabled" };
        void finishVoice(ctx);
        return { accepted: true, mode: null };
      }
      case "rename":
        pi.setSessionName(String(args.name ?? ""));
        return { accepted: true, mode: "immediate" };
      case "spawn": {        const result = spawner.spawn({ name: typeof args.name === "string" ? args.name : undefined });
        if (!result.ok) return { accepted: false, mode: null, error: result.error };
        safe(() => bridge?.publishMeta(buildMeta(ctx)));
        return {
          accepted: true,
          mode: "immediate",
          data: { sessionId: result.sessionId, name: result.name, cwd: result.cwd ?? null, pid: result.pid ?? null },
        };
      }
      default:
        return { accepted: false, mode: null, error: `unknown_op:${op}` };
    }
  }

  // Walking a tree on every keystroke is wasted work — the answer only changes when
  // files do, and a few seconds of staleness is invisible in a completion list.
  let filesCache: { cwd: string; at: number; files: string[] } | undefined;
  function cachedWalk(cwd: string): string[] {
    const now = Date.now();
    if (!filesCache || filesCache.cwd !== cwd || now - filesCache.at > FILES_CACHE_MS) {
      filesCache = { cwd, at: now, files: walkFiles(cwd) };
    }
    return filesCache.files;
  }

  /**
   * Map a portal built-in onto the op that implements it, so both entry points share
   * one implementation. A built-in that needs an argument says so rather than
   * guessing; `/session` answers with a line of facts.
   */
  function rewritePortalCommand(
    name: string,
    args: string,
    ctx: NonNullable<typeof activeCtx>,
  ): { op?: string; args?: Json; refuse?: string; error?: string } {
    switch (name) {
      case "compact":
        return { op: "compact", args: { instructions: args } };
      case "model": {
        if (!args) return { error: "command_needs_argument", refuse: "Give a model, like /model anthropic/claude-sonnet-4" };
        const slash = args.indexOf("/");
        if (slash < 1) return { error: "command_needs_argument", refuse: "Give a model as provider/id, like /model anthropic/claude-sonnet-4" };
        return { op: "set_model", args: { provider: args.slice(0, slash), modelId: args.slice(slash + 1) } };
      }
      case "thinking":
        return args
          ? { op: "set_thinking", args: { level: args } }
          : { error: "notice", refuse: `Thinking is ${ctx.thinkingLevel ?? "off"}. Set it with /thinking <level>.` };
      case "name":
        return args ? { op: "rename", args: { name: args } } : { error: "command_needs_argument", refuse: "Give a name, like /name Refactor" };
      case "session": {
        const entries = ctx.sessionManager.getEntries() as unknown as Json[];
        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
        return { error: "notice", refuse: `${ctx.sessionManager.getCwd()} · ${entries.length} entries · ${model}` };
      }
      default:
        return {};
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
    startVoiceBridge();
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
    // Which sessions publish themselves:
    //   * created through a spawner → yes. The spawner is triggered from the PiNet
    //     UI, so the user may have no shell on this host to mount it by hand.
    //   * a pi session started directly on the host → no. Publishing it is a
    //     decision, not a default; `/portal mount` inside it publishes it.
    // PINET_AUTO_MOUNT=1 restores the old behaviour for a host that is only
    // reachable through PiNet (the VM runs this, so its session keeps working).
    trace("autoStart");
    try {
      const state = loadHostState(dir);
      // Mounting once is remembered on disk: `/portal mount` has to survive a
      // restart, or a host reachable only through PiNet goes dark on every restart
      // — which is exactly what happened. A marker file rather than a field in
      // host.json, which loadHostState is free to narrow.
      const autoMount =
        process.env.PINET_SPAWNED === "1" || process.env.PINET_AUTO_MOUNT === "1" || existsSync(`${dir}/auto-mount`);
      if (!autoMount) {
        trace("direct session: not mounted (run /portal mount)");
        return;
      }
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

  // -- /rc: start a spawner daemon -------------------------------------------
  //
  // Spawners are started by hand on a host, never from the PiNet UI. The daemon is
  // detached, so the pi session you run this in is only a launcher — and it stays
  // unpublished, because a session started directly on the host does not mount
  // itself. A spawner advertises a directory scope; sessions inside that scope are
  // created from the UI.
  const spawnerStatePath = `${dir}/spawners.json`;
  const readSpawners = (): { pid: number; root: string; at: string }[] => {
    try {
      return JSON.parse(readFileSync(spawnerStatePath, "utf8")) as { pid: number; root: string; at: string }[];
    } catch {
      return [];
    }
  };
  const writeSpawners = (entries: { pid: number; root: string; at: string }[]): void => {
    try {
      writeFileSync(spawnerStatePath, JSON.stringify(entries, null, 2));
    } catch {
      /* best effort */
    }
  };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  pi.registerCommand("rc", {
    description: "PiNet spawner: /rc [dir] | /rc stop | /rc status",
    handler: async (args, ctx) => {
      const [sub = "", rest = ""] = [args.trim().split(/\s+/)[0] ?? "", args.trim().split(/\s+/).slice(1).join(" ")];
      if (sub === "status" || (!sub && readSpawners().length)) {
        const running = readSpawners().filter((entry) => alive(entry.pid));
        notify(
          ctx,
          running.length
            ? `Spawners on this host:\n${running.map((entry) => `  pid ${entry.pid}  ${entry.root}`).join("\n")}`
            : "No spawners running on this host. Start one with /rc [dir].",
          running.length ? "info" : "warning",
        );
        if (!sub) return;
      }
      if (sub === "stop") {
        const running = readSpawners().filter((entry) => alive(entry.pid));
        for (const entry of running) {
          try {
            process.kill(entry.pid, "SIGTERM");
          } catch {
            /* already gone */
          }
        }
        writeSpawners([]);
        notify(ctx, running.length ? `Stopped ${running.length} spawner(s).` : "No spawners to stop.", "info");
        return;
      }
      const target = rest || (sub && sub !== "start" ? sub : "") || ctx.cwd;
      try {
        const daemon = fileURLToPath(new URL("../src/spawner/daemon.mjs", import.meta.url));
        const child = spawnProcess(process.execPath, [daemon, "--dir", target], { detached: true, stdio: "ignore" });
        child.unref();
        const entries = [...readSpawners().filter((entry) => alive(entry.pid)), { pid: child.pid ?? 0, root: target, at: new Date().toISOString() }];
        writeSpawners(entries);
        notify(ctx, `Spawner started in ${target}\nSessions created inside it appear in PiNet and mount themselves.\n/rc status shows it, /rc stop stops it.`, "info");
      } catch (error) {
        notify(ctx, `Could not start a spawner: ${String((error as Error)?.message ?? error)}`, "error");
      }
    },
  });

  pi.registerCommand("pinet", {
    description: "PiNet remote control: /pinet setup | mount | status | reconnect | logout",
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

      if (sub === "mount") {
        // `mount` is the host-side verb, so it belongs here. `/portal` is the
        // controller command — `setup`, `sessions`, `attach`, `detach` all act on
        // remote sessions — and `mount` was the one verb under it that acts on this
        // side. `/portal mount` still works: it reaches this same function through
        // the event bus.
        if (!state.hostId) {
          notify(ctx, "PiNet: not enrolled yet — run /pinet setup first.", "warning");
          return;
        }
        if (bridge?.socket?.ready && sessionId) {
          notify(ctx, `PiNet: already published (${sessionId}).`, "info");
          return;
        }
        await mountHost();
        notify(ctx, sessionId ? `PiNet: published ${sessionId}.` : "PiNet: mounting — this session will appear shortly.", "info");
        return;
      }

      notify(ctx, "Usage: /pinet setup | mount | status | reconnect | logout", "warning");
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
    takeAudio();
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
    lastSettledAt = Date.now();
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

  // -- voice ----------------------------------------------------------------

  function takeAudio(): { index: number; data: string }[] {
    const chunks = audioChunks;
    audioChunks = [];
    return chunks;
  }

  /**
   * Dictated audio → transcript → cleaned text. The result is published as a
   * sealed `session.voice` frame and deliberately *not* echoed in the command
   * ack: acks are plaintext at the coordinator, and this is the user's speech.
   */
  async function finishVoice(ctx: ExtensionContext): Promise<void> {
    const chunks = takeAudio();
    if (!voicePipeline?.enabled || !chunks.length) {
      safe(() => bridge?.publishVoice({ text: "", raw: "", flags: [chunks.length ? "voice_disabled" : "no_speech"] }));
      return;
    }
    try {
      const result = await voicePipeline.finish(chunks, { context: { cwd: ctx.cwd }, spool: voiceSpool });
      trace(
        "voice",
        `chunks=${chunks.length} duration=${result.durationMs ?? 0}ms segments=${result.segments ?? 1} rl=${result.rateLimit?.concurrency ?? 0}c/${result.rateLimit?.throttled ?? 0}t asr=${result.timings?.asrMs ?? 0}ms clean=${result.timings?.cleanMs ?? 0}ms total=${result.timings?.totalMs ?? 0}ms flags=${result.flags.join(",") || "-"}`,
      );
      safe(() => bridge?.publishVoice(result));
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "voice_failed";
      reportError("voice", error);
      safe(() => bridge?.publishVoice({ text: "", raw: "", flags: [code] }));
    }
  }

  /** Re-run a take that failed: the audio is still in the spool. */
  async function retryVoice(ctx: ExtensionContext, spoolId?: string): Promise<void> {
    if (!voicePipeline || !voiceSpool) return;
    try {
      const result = await voicePipeline.retry(spoolId, { context: { cwd: ctx.cwd }, spool: voiceSpool });
      trace("voice retry", `id=${result.spoolId} duration=${result.durationMs ?? 0}ms asr=${result.timings?.asrMs ?? 0}ms flags=${result.flags.join(",") || "-"}`);
      safe(() => bridge?.publishVoice(result));
    } catch (error) {
      reportError("voice retry", error);
      safe(() => bridge?.publishVoice({ text: "", raw: "", flags: [(error as { code?: string })?.code ?? "voice_failed"] }));
    }
  }

  function startVoiceBridge(): void {
    if (!voicePipeline?.enabled) return;
    bridge?.onAudio(({ index, data }) => {
      // Chunk 0 starts a new take: the browser must not have to make a round trip
      // before capturing (that would consume its user-gesture window), so the
      // reset happens here instead of on a `voice.start` command.
      if (index === 0) audioChunks = [];
      if (audioChunks.length >= MAX_AUDIO_CHUNKS) return;
      audioChunks.push({ index, data });
    });
  }

  /**
   * Publish this session now. Spawned sessions skip auto-mount, so this is what
   * `/portal mount` triggers.
   */
  async function mountHost(): Promise<void> {
    if (isSubagentChild) return;
    if (bridge?.socket?.ready && sessionId) return;
    const state = loadHostState(dir);
    if (!state.hostId || !state.identity || !state.encryption) {
      trace("mount skipped: not enrolled");
      return;
    }
    try {
      await connectBridge();
      if (activeCtx && !sessionId) registerSession(activeCtx);
      // Remember the decision: next start mounts without a command.
      try {
        if (!existsSync(`${dir}/auto-mount`)) writeFileSync(`${dir}/auto-mount`, `${new Date().toISOString()}\n`);
      } catch {
        /* best effort */
      }
      trace("mounted on request", `sessionId=${sessionId ?? "-"}`);
    } catch (error) {
      reportError("mount", error);
    }
  }

  pi.events?.on?.("pinet:mount", () => void mountHost());

  void autoStart();
  trace("extension loaded");
}
