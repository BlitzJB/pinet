// Controller client.
//
// Runtime-agnostic: the only injected dependency is a CryptoProvider. With the
// default (Node) provider it runs in Node; pass `webCryptoProvider` and the
// global WebSocket (browser/Deno/Bun) to run it unchanged in a web app.

import { canonicalJson } from "../common/canonical.mjs";
import { Emitter } from "../common/emitter.mjs";
import { PinetSocket } from "../common/ws-client.mjs";
import { commandAad, frameAad, openJson, sealJson, unwrapGroupKey } from "../crypto/session-crypto.mjs";

export class PinetController extends Emitter {
  constructor({ url, deviceId, identity, encryption, deviceName, crypto, reconnect = false } = {}) {
    super();
    this.url = url;
    this.deviceId = deviceId;
    this.identity = identity;
    this.encryption = encryption;
    this.deviceName = deviceName;
    this.cryptoProvider = crypto;
    this.reconnectOption = reconnect;
    this.socket = undefined;
    this.keys = new Map(); // sessionId -> { epoch, key }
    this.epochs = new Map();
    this.attached = new Map(); // sessionId -> mode
    this.commandWaiters = new Map();
    this.snapshots = new Map();
    this.queue = Promise.resolve();
  }

  getSnapshot(sessionId) {
    return this.snapshots.get(sessionId);
  }

  #enqueue(task) {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  get crypto() {
    return this.cryptoProvider;
  }

  async connect() {
    const provider = this.cryptoProvider ?? (await import(/* @vite-ignore */ "../crypto/provider.mjs")).nodeCryptoProvider;
    this.cryptoProvider = provider;
    const socket = new PinetSocket(this.url, { crypto: provider, reconnect: this.reconnectOption });
    this.socket = socket;

    socket.on("disconnected", () => {
      for (const attached of this.attached.keys()) this.keys.delete(attached);
      this.emit("disconnected");
    });
    socket.on("reconnecting", (info) => this.emit("reconnecting", info));
    socket.on("reconnected", () => void this.#resync());

    socket.on("e2e.key", (data) => this.#enqueue(() => this.#onKey(data)));
    for (const type of ["session.snapshot", "session.rebase", "session.entries", "session.status", "session.meta"]) {
      socket.on(type, (data, msg) => this.#enqueue(() => this.#onFrame(type, data, msg)));
    }
    socket.on("session.removed", (data) => this.emit("removed", data));
    socket.on("cmd.ack", (data) => {
      const waiter = this.commandWaiters.get(data.commandId);
      if (waiter) {
        this.commandWaiters.delete(data.commandId);
        clearTimeout(waiter.timer);
        waiter.resolve(data);
      }
      this.emit("cmd.ack", data);
    });
    socket.on("closed", () => this.emit("closed"));

    return socket.connect({ role: "controller", deviceId: this.deviceId, identityPrivateKey: this.identity.privateKey });
  }

  close() {
    this.socket?.close();
  }

  async list() {
    await this.socket.waitForReady(15_000);
    const wait = this.socket.waitFor("ctl.catalog");
    this.socket.send("ctl.list", {});
    return (await wait).sessions ?? [];
  }

  async attach(sessionId, mode = "control") {
    const keyPromise = this.socket.waitFor("e2e.key", { predicate: (data) => data.sessionId === sessionId, timeoutMs: 15_000 });
    const attachedPromise = this.socket.waitFor("ctl.attached", { predicate: (data) => data.sessionId === sessionId });
    this.socket.send("ctl.attach", { sessionId, mode });
    const attached = await attachedPromise;
    await keyPromise;
    await this.queue; // ensure the key has actually been unwrapped and stored
    this.attached.set(sessionId, mode);
    return attached;
  }

  detach(sessionId) {
    this.attached.delete(sessionId);
    this.socket.send("ctl.detach", { sessionId });
  }

  async #sealCommand(sessionId, op, args) {
    const entry = this.keys.get(sessionId);
    if (!entry) throw new Error(`no session key for ${sessionId}`);
    const provider = this.cryptoProvider;
    const epoch = entry.epoch;
    const commandId = Array.from(provider.randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
    const aad = commandAad({ sessionId, commandId, epoch, op, deviceId: this.deviceId });
    const enc = await sealJson(provider, entry.key, args, aad);
    const sig = await provider.sign(
      canonicalJson({ sessionId, commandId, epoch, op, deviceId: this.deviceId, enc }),
      this.identity.privateKey,
    );
    return { sessionId, commandId, epoch, op, enc, sig };
  }

  async #dispatchCommand(sessionId, op, args) {
    const frame = await this.#sealCommand(sessionId, op, args);
    let timer;
    const wait = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.commandWaiters.delete(frame.commandId);
        reject(new Error("no ack (connection may have dropped); verify the remote before retrying"));
      }, 60_000);
      timer.unref?.();
      this.commandWaiters.set(frame.commandId, { resolve, timer });
    });
    try {
      this.socket.send("ctl.command", frame);
    } catch (error) {
      this.commandWaiters.delete(frame.commandId);
      clearTimeout(timer);
      throw error;
    }
    return wait;
  }

  async command(sessionId, op, args = {}) {
    await this.socket.waitForReady(15_000);
    if (!this.keys.has(sessionId) && this.attached.has(sessionId)) await this.#waitForKey(sessionId, 15_000);
    if (!this.keys.has(sessionId)) throw new Error(`no session key for ${sessionId}; attach first`);
    try {
      return await this.#dispatchCommand(sessionId, op, args);
    } catch (error) {
      // Only retry if the send itself failed because the socket was closing.
      if (this.reconnectOption && String(error?.message ?? "").includes("not connected")) {
        await this.socket.waitForReady(15_000);
        await this.#waitForKey(sessionId, 15_000);
        return this.#dispatchCommand(sessionId, op, args);
      }
      throw error;
    }
  }

  async #waitForKey(sessionId, timeoutMs) {
    const started = Date.now();
    while (!this.keys.has(sessionId)) {
      if (Date.now() - started > timeoutMs) throw new Error(`no session key for ${sessionId}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // After a reconnect, re-attach every session and wait for fresh keys.
  async #resync() {
    const entries = [...this.attached.entries()];
    for (const [attachedSession, mode] of entries) {
      try {
        this.keys.delete(attachedSession);
        await this.attach(attachedSession, mode);
      } catch (error) {
        this.emit("resync_error", { sessionId: attachedSession, error: String(error?.message ?? error) });
      }
    }
    this.emit("resynced", { sessions: entries.map(([id]) => id) });
  }

  async #onKey(data) {
    const { sessionId, epoch } = data;
    const key = await unwrapGroupKey(this.cryptoProvider, {
      recipientEncPriv: this.encryption.privateKey,
      hostEphPub: data.wrapped.hostEphPub,
      wrapped: data.wrapped,
      aadParts: { sessionId, epoch, deviceId: this.deviceId },
    });
    this.keys.set(sessionId, { epoch, key });
    this.epochs.set(sessionId, epoch);
    this.emit("key", { sessionId, epoch });
  }

  async #onFrame(type, data, msg) {
    const route = msg?.route ?? {};
    const sessionId = route.sessionId ?? data.sessionId;
    const epoch = route.epoch ?? data.epoch;
    const entry = this.keys.get(sessionId);
    if (!entry) return;
    let payload;
    try {
      payload = await openJson(this.cryptoProvider, entry.key, data.enc, frameAad({ sessionId, epoch, seq: data.seq, type }));
    } catch (error) {
      this.emit("decrypt_error", { sessionId, epoch, seq: data.seq, type, error: String(error?.message ?? error) });
      return;
    }
    const event = { sessionId, epoch, seq: data.seq, ...payload };
    if (type === "session.snapshot") {
      this.snapshots.set(sessionId, event);
      this.emit("snapshot", event);
    } else if (type === "session.rebase") this.emit("rebase", event);
    else if (type === "session.entries") this.emit("entries", event);
    else if (type === "session.status") this.emit("status", event);
    else if (type === "session.meta") this.emit("meta", event);
  }
}
