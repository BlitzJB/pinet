import { PinetController } from "../../../src/controller/client.mjs";
import { describeEntry } from "../../../src/controller/portal.mjs";
import { webCryptoProvider } from "../../../src/crypto/webcrypto.mjs";
import type { ServerSession, SpawnCapability } from "./api";
import { getMe } from "./api";
import { ensureDevice, loadDevice, clearDevice, type StoredDevice } from "./device";
import type { Outbox } from "./run-state";
import { Store } from "./store";

export interface DisplayEntry {
  id?: string;
  kind?: string;
  title?: string;
  body?: string;
  text?: string;
  reasoning?: string;
  tools?: { id?: string; name: string; args?: string }[];
  toolCallId?: string;
  timestamp?: number;
  error?: boolean;
  summary?: string;
  tokensBefore?: number | null;
  fromHook?: boolean;
}

export interface SessionStatus {
  phase?: string;
  isIdle?: boolean;
  model?: { provider: string; id: string; name?: string } | null;
  thinkingLevel?: string | null;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
  runningTools?: unknown[];
  run?: { id?: string; startedAt?: number; state?: string } | null;
  compacting?: { reason?: string } | null;
}

export interface SessionMeta {
  name?: string | null;
  cwd?: string | null;
  host?: string;
  spawn?: SpawnCapability | null;
}

export type AttachmentMode = "read" | "control";

export interface SessionState {
  sessionId: string;
  entries: DisplayEntry[];
  status: SessionStatus | null;
  meta: SessionMeta | null;
  epoch: number;
  mode: AttachmentMode;
  attached: boolean;
  /** True while a full refetch (initial attach / gap resync) is in flight. */
  syncing: boolean;
  pendingEchoes: number;
  outbox: Outbox | null;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  providerName?: string;
  reasoning?: boolean;
  contextWindow?: number | null;
}

const MODEL_CACHE_MS = 5 * 60_000;

export type ConnStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";
export interface ConnState {
  status: ConnStatus;
  error?: string;
  deviceId?: string;
}

function wsUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

function localId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `local-${Date.now()}-${Math.random()}`;
}

export class PinetConnection {
  readonly conn = new Store<ConnState>({ status: "idle" });
  private controller?: PinetController;
  private stores = new Map<string, Store<SessionState>>();
  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>();
  private connecting?: Promise<void>;

  store(sessionId: string): Store<SessionState> {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = new Store<SessionState>({
        sessionId,
        entries: [],
        status: null,
        meta: null,
        epoch: 0,
        mode: "control",
        attached: false,
        syncing: false,
        pendingEchoes: 0,
        outbox: null,
      });
      this.stores.set(sessionId, store);
    }
    return store;
  }

  connect(): Promise<void> {
    if (this.controller) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.#connect().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  async #connect(): Promise<void> {
    this.conn.set({ status: "connecting" });
    try {
      const device = await this.#connectWithDevice();
      this.conn.set({ status: "connected", deviceId: device.deviceId, error: undefined });
    } catch (error) {
      // The stored device may have been revoked or cleared server-side. Forget
      // it and register a fresh controller once.
      const stored = await loadDevice();
      if (stored) {
        try {
          await clearDevice();
          const device = await this.#connectWithDevice();
          this.conn.set({ status: "connected", deviceId: device.deviceId, error: undefined });
          return;
        } catch (retryError) {
          error = retryError;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      this.controller = undefined;
      this.conn.set({ status: "error", error: message });
      throw error;
    }
  }

  async #connectWithDevice(): Promise<StoredDevice> {
    // The browser's controller key is per-origin, so make sure it belongs to the
    // account this session is signed in to before using it.
    const me = await getMe().catch(() => null);
    const device = await ensureDevice(me?.accountId);
    const controller = new PinetController({
      url: wsUrl(),
      deviceId: device.deviceId,
      identity: device.identity,
      encryption: device.encryption,
      crypto: webCryptoProvider,
      reconnect: true,
    });
    this.#wire(controller);
    await controller.connect();
    this.controller = controller;
    return device;
  }

  #wire(controller: PinetController): void {
    controller.on("disconnected", () => this.conn.set({ status: "reconnecting" }));
    controller.on("reconnecting", () => this.conn.set({ status: "reconnecting" }));
    controller.on("reconnected", () => this.conn.set({ status: "connected" }));
    controller.on("gap", (data: any) => this.store(data.sessionId).set({ syncing: true }));
    controller.on("resynced", (data: any) => {
      for (const id of (data?.sessions ?? []) as string[]) this.store(id).set({ syncing: false });
      this.conn.set({ status: "connected" });
    });
    controller.on("resync_error", (data: any) => this.store(data.sessionId).set({ syncing: false }));
    controller.on("snapshot", (data: any) => this.#applyFull(data.sessionId, data.entries, data.status, data.meta, data.epoch));
    controller.on("rebase", (data: any) => this.#applyFull(data.sessionId, data.entries, undefined, undefined, data.epoch));
    controller.on("entries", (data: any) => this.#applyDelta(data.sessionId, data.entries, data.epoch));
    controller.on("status", (data: any) => {
      const store = this.store(data.sessionId);
      const status: SessionStatus | null = data.status ?? null;
      store.set((state) => {
        let outbox = state.outbox;
        if (outbox && outbox.status !== "error") {
          if (status?.run) {
            outbox = { ...outbox, status: "working", sawRun: true };
          } else if (outbox.sawRun && (status?.isIdle === true || status?.phase === "idle")) {
            outbox = null;
          }
        }
        return { status, epoch: data.epoch ?? 0, outbox };
      });
    });
    controller.on("meta", (data: any) => this.store(data.sessionId).set({ meta: data.meta ?? null }));
    controller.on("removed", (data: any) => this.store(data.sessionId).set({ attached: false }));
    controller.on("decrypt_error", () => this.conn.set((state) => ({ ...state })));
  }

  list(): Promise<ServerSession[]> {
    if (!this.controller) throw new Error("not connected");
    return this.controller.list() as Promise<ServerSession[]>;
  }

  async attach(sessionId: string, mode: AttachmentMode = "control"): Promise<void> {
    if (!this.controller) throw new Error("not connected");
    this.store(sessionId).set({ syncing: true });
    try {
      await this.controller.attach(sessionId, mode);
      this.store(sessionId).set({ attached: true, mode });
    } catch (error) {
      this.store(sessionId).set({ syncing: false });
      throw error;
    }
  }

  detach(sessionId: string): void {
    this.controller?.detach(sessionId);
    this.store(sessionId).set({ attached: false, syncing: false });
  }

  /** Optimistically echo the user's message, then send it and track delivery. */
  async prompt(sessionId: string, text: string): Promise<void> {
    if (!this.controller) throw new Error("not connected");
    const store = this.store(sessionId);
    store.set((state) => ({
      entries: [...state.entries, { id: `local-${localId()}`, kind: "user", title: "you", body: text, text }],
      pendingEchoes: state.pendingEchoes + 1,
      outbox: { status: "sending", at: Date.now(), entriesAt: state.entries.length + 1, sawRun: false },
    }));
    try {
      const ack = (await this.controller.command(sessionId, "prompt", { text })) as { accepted?: boolean; mode?: string; error?: string } | undefined;
      if (ack && ack.accepted === false) {
        store.set((state) => ({
          pendingEchoes: Math.max(0, state.pendingEchoes - 1),
          outbox: { status: "error", at: Date.now(), error: ack.error ?? "rejected" },
        }));
        return;
      }
      store.set((state) => {
        const outbox = state.outbox;
        if (outbox && outbox.status === "sending") {
          const status = ack?.mode === "immediate" ? "delivered" : "queued";
          return { outbox: { ...outbox, status, mode: ack?.mode } };
        }
        return {};
      });
    } catch (error) {
      store.set((state) => ({
        pendingEchoes: Math.max(0, state.pendingEchoes - 1),
        outbox: { status: "error", at: Date.now(), error: String((error as Error)?.message ?? error) },
      }));
      throw error;
    }
  }

  abort(sessionId: string): Promise<unknown> {
    return this.controller!.command(sessionId, "abort", {});
  }
  compact(sessionId: string, instructions?: string): Promise<unknown> {
    return this.controller!.command(sessionId, "compact", instructions ? { instructions } : {});
  }
  /** Model catalogue the host offers, cached briefly (it is acked, not streamed). */
  async listModels(sessionId: string, { refresh = false }: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    if (!this.controller) throw new Error("not connected");
    const cached = this.modelCache.get(sessionId);
    if (!refresh && cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
    const ack = (await this.controller.command(sessionId, "list_models", {})) as
      | { accepted?: boolean; error?: string; data?: { models?: ModelInfo[] } }
      | undefined;
    if (ack?.accepted === false) throw new Error(ack.error ?? "list_models failed");
    const models = ack?.data?.models ?? [];
    this.modelCache.set(sessionId, { at: Date.now(), models });
    return models;
  }

  /** Optimistic so the chip updates immediately; the host confirms via status. */
  async setModel(sessionId: string, provider: string, modelId: string, name?: string): Promise<void> {
    if (!this.controller) throw new Error("not connected");
    const store = this.store(sessionId);
    const previous = store.get().status?.model ?? null;
    store.set((state) =>
      state.status ? { status: { ...state.status, model: { provider, id: modelId, name: name ?? modelId } } } : state,
    );
    try {
      const ack = (await this.controller.command(sessionId, "set_model", { provider, modelId })) as
        | { accepted?: boolean; error?: string }
        | undefined;
      if (ack && ack.accepted === false) throw new Error(ack.error ?? "set_model failed");
    } catch (error) {
      store.set((state) => (state.status ? { status: { ...state.status, model: previous } } : state));
      throw error;
    }
  }
  setThinking(sessionId: string, level: string): Promise<unknown> {
    return this.controller!.command(sessionId, "set_thinking", { level });
  }
  /** Ask a host to spawn a new session (session/worktree spawn mode). */
  async spawn(sessionId: string, options: { name?: string; mode?: string } = {}): Promise<{ sessionId?: string; name?: string }> {
    if (!this.controller) throw new Error("not connected");
    // Commands need the session group key. The sidebar can trigger a spawn
    // before the session view has finished attaching, so make sure first.
    if (!this.store(sessionId).get().attached) await this.attach(sessionId, "control");
    const ack = (await this.controller.command(sessionId, "spawn", options)) as
      | { accepted?: boolean; error?: string; data?: { sessionId?: string; name?: string } }
      | undefined;
    if (ack?.accepted === false) throw new Error(ack.error ?? "spawn failed");
    return ack?.data ?? {};
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const store = this.store(sessionId);
    const previous = store.get().meta?.name ?? null;
    store.set((state) => ({ meta: { ...(state.meta ?? {}), name } }));
    try {
      const ack = (await this.controller!.command(sessionId, "rename", { name })) as
        | { accepted?: boolean; error?: string }
        | undefined;
      if (ack && ack.accepted === false) throw new Error(ack.error ?? "rename failed");
    } catch (error) {
      store.set((state) => ({ meta: { ...(state.meta ?? {}), name: previous } }));
      throw error;
    }
  }

  #applyFull(sessionId: string, entries: unknown[], status?: SessionStatus, meta?: SessionMeta, epoch?: number): void {
    const seen = new Set<string>();
    const mapped: DisplayEntry[] = [];
    for (const entry of (entries ?? []) as { id?: string }[]) {
      if (!entry?.id || seen.has(entry.id)) continue;
      const record = describeEntry(entry) as DisplayEntry | null;
      if (!record) continue;
      seen.add(entry.id);
      mapped.push(record);
    }
    const store = this.store(sessionId);
    // A full snapshot is exactly what a refetch was waiting for, so it is the
    // authoritative place to clear `syncing` (deltas must not touch it).
    store.set((state) => ({
      entries: mapped,
      status: status ?? state.status,
      meta: meta ?? state.meta,
      epoch: epoch ?? state.epoch,
      attached: true,
      syncing: false,
    }));
  }

  #applyDelta(sessionId: string, entries: unknown[], epoch?: number): void {
    const store = this.store(sessionId);
    const state = store.get();
    const seen = new Set<string>();
    for (const entry of state.entries) if (entry.id) seen.add(entry.id);
    const mapped = [...state.entries];
    let pending = state.pendingEchoes;
    for (const entry of (entries ?? []) as { id?: string }[]) {
      if (!entry?.id || seen.has(entry.id)) continue;
      const record = describeEntry(entry) as DisplayEntry | null;
      seen.add(entry.id);
      if (!record) continue;
      if (record.kind === "user" && pending > 0) {
        pending -= 1; // remote echo of a message already shown optimistically
        continue;
      }
      mapped.push(record);
    }
    store.set({ entries: mapped, pendingEchoes: pending, epoch: epoch ?? state.epoch });
  }
}
