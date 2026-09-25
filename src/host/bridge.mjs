// Host bridge: authenticates to the coordinator, manages per-epoch session
// group keys, encrypts all outbound session frames, verifies + decrypts
// controller commands, and acknowledges them.

import { EventEmitter } from "node:events";
import { canonicalJson } from "../common/canonical.mjs";
import { PinetSocket } from "../common/ws-client.mjs";
import { verify, sign } from "../crypto/keys.mjs";
import { commandAad, frameAad, generateGroupKey, openJson, sealJson, wrapGroupKey } from "../crypto/e2e.mjs";

const MAX_SEEN_COMMANDS = 1000;

export class HostBridge extends EventEmitter {
  constructor({ url, deviceId, identity, encryption, hostName, agent }) {
    super();
    this.url = url;
    this.deviceId = deviceId;
    this.identity = identity;
    this.encryption = encryption;
    this.hostName = hostName;
    this.agent = agent;
    this.socket = undefined;
    this.session = undefined;
    this.snapshotProvider = () => ({ entries: [], status: null, meta: {} });
    this.commandHandler = async () => ({ accepted: false, mode: null, error: "no_handler" });
    this.pinnedControllers = new Map();
    this.seenCommands = new Map();
    this.seenCommandOrder = [];
  }

  setSnapshotProvider(fn) {
    this.snapshotProvider = fn;
  }

  onCommand(fn) {
    this.commandHandler = fn;
  }

  async connect() {
    const socket = new PinetSocket(this.url, { reconnect: true });
    this.socket = socket;
    socket.on("host.attach", (data) => this.#onAttach(data));
    socket.on("cmd.deliver", (data) => void this.#onCommand(data));
    socket.on("disconnected", () => this.emit("disconnected"));
    socket.on("reconnecting", (info) => this.emit("reconnecting", info));
    // Every successful (re)connect, including the first one — a busy host can
    // miss the initial handshake deadline, and the socket keeps retrying.
    // (The socket emits "ready" on every connect, so this must be the only hook
    // or a reconnect would rotate the epoch twice.)
    socket.on("ready", () => this.#onReconnected());
    socket.on("closed", () => this.emit("closed"));
    // Keying and a 5.6MB session can block startup past the 10s default.
    return socket.connect({
      role: "host",
      deviceId: this.deviceId,
      identityPrivateKey: this.identity.privateKey,
      timeoutMs: 30_000,
    });
  }

  // On network reconnect the host rotates the session epoch and group key,
  // re-wraps the key for every known attachment, and sends a fresh snapshot.
  #onReconnected() {
    const session = this.session;
    if (!session) {
      this.emit("reconnected", { session: null });
      return;
    }
    session.epoch += 1;
    session.groupKey = generateGroupKey();
    session.keyEpoch = session.epoch;
    session.seq = 0;
    this.socket.send("session.opened", { sessionId: session.sessionId, meta: session.meta });
    for (const [attachmentId, info] of session.controllers) {
      this.#publishKey(session, attachmentId, info);
    }
    const snapshot = this.snapshotProvider() ?? {};
    const seq = (session.seq += 1);
    const aad = frameAad({ sessionId: session.sessionId, epoch: session.epoch, seq, type: "session.snapshot" });
    const enc = sealJson(session.groupKey, snapshot, aad);
    this.socket.send(
      "session.snapshot",
      { epoch: session.epoch, seq, enc },
      { sessionId: session.sessionId, epoch: session.epoch },
    );
    this.emit("reconnected", { session: session.sessionId, epoch: session.epoch });
  }

  openSession({ sessionId, meta }) {
    this.session = {
      sessionId,
      meta: meta ?? {},
      epoch: 1,
      seq: 0,
      groupKey: generateGroupKey(),
      keyEpoch: 1,
      controllers: new Map(),
    };
    this.socket.send("session.opened", { sessionId, meta: meta ?? {} });
    this.emit("opened", this.session);
  }

  closeSession(reason = "shutdown") {
    if (!this.session) return;
    this.socket.send("session.closed", { sessionId: this.session.sessionId, reason });
    this.session = undefined;
  }

  startEpoch() {
    const session = this.#requireSession();
    session.epoch += 1;
    session.groupKey = generateGroupKey();
    session.keyEpoch = session.epoch;
    session.seq = 0;
    return session.epoch;
  }

  publishSnapshot({ entries = [], status = null, meta = undefined, leafId = null } = {}) {
    this.#publish("session.snapshot", { entries, status, meta: meta ?? this.session.meta, leafId });
  }

  publishEntries(entries) {
    if (!entries?.length) return;
    this.#publish("session.entries", { entries });
  }

  publishRebase(entries, leafId = null) {
    this.#publish("session.rebase", { entries, leafId });
  }

  publishStatus(status) {
    this.#publish("session.status", { status });
  }

  publishMeta(meta) {
    this.session.meta = meta;
    // meta (name/cwd/host) is published in the clear, exactly like
    // `session.opened`, so the coordinator's catalog reflects renames without
    // it needing to read any session payload.
    this.socket.send("session.meta", { meta }, { sessionId: this.session.sessionId, epoch: this.session.epoch });
  }

  #publish(type, payload) {
    const session = this.#requireSession();
    const seq = (session.seq += 1);
    const aad = frameAad({ sessionId: session.sessionId, epoch: session.epoch, seq, type });
    const enc = sealJson(session.groupKey, payload, aad);
    this.socket.send(type, { epoch: session.epoch, seq, enc }, { sessionId: session.sessionId, epoch: session.epoch });
  }

  #requireSession() {
    if (!this.session) throw new Error("no active session");
    return this.session;
  }

  #publishKey(session, attachmentId, info) {
    const wrapped = wrapGroupKey({
      recipientEncPub: info.encPub,
      groupKey: session.groupKey,
      aadParts: { sessionId: session.sessionId, epoch: session.epoch, deviceId: info.deviceId },
    });
    // Sign the wrap so a malicious coordinator cannot substitute the group key.
    const sig = sign(
      canonicalJson({ type: "e2e.key", sessionId: session.sessionId, attachmentId, epoch: session.epoch, wrapped, deviceId: this.deviceId }),
      this.identity.privateKey,
    );
    this.socket.send(
      "e2e.key",
      { sessionId: session.sessionId, attachmentId, epoch: session.epoch, wrapped, deviceId: this.deviceId, sig },
      { sessionId: session.sessionId, epoch: session.epoch },
    );
  }

  #onAttach(data) {
    const session = this.session;
    if (!session || data.sessionId !== session.sessionId) return;
    const { deviceId, identityPub, encPub } = data.controller;
    const pinned = this.pinnedControllers.get(deviceId);
    if (pinned && pinned !== identityPub) {
      this.emit("security", { code: "controller_key_changed", deviceId });
      return;
    }
    this.pinnedControllers.set(deviceId, identityPub);
    session.controllers.set(data.attachmentId, { deviceId, identityPub, encPub });
    if (session.keyEpoch !== session.epoch || !session.groupKey) {
      session.groupKey = generateGroupKey();
      session.keyEpoch = session.epoch;
    }
    this.#publishKey(session, data.attachmentId, { deviceId, encPub });
    // Fresh encrypted snapshot for the new controller.
    const snapshot = this.snapshotProvider() ?? {};
    const seq = (session.seq += 1);
    const aad = frameAad({ sessionId: session.sessionId, epoch: session.epoch, seq, type: "session.snapshot" });
    const enc = sealJson(session.groupKey, snapshot, aad);
    this.socket.send(
      "session.snapshot",
      { epoch: session.epoch, seq, enc },
      { sessionId: session.sessionId, epoch: session.epoch },
    );
  }

  async #onCommand(data) {
    const session = this.session;
    const reply = (accepted, mode = null, error = null, extra = null) =>
      this.socket.send("cmd.ack", { commandId: data.commandId, accepted, mode, error, ...(extra ? { data: extra } : {}) });
    if (!session || data.sessionId !== session.sessionId) return reply(false, null, "no_active_session");
    const attachment = session.controllers.get(data.attachmentId);
    if (!attachment) return reply(false, null, "unknown_attachment");
    if (data.epoch !== session.epoch) return reply(false, null, "stale_epoch");
    if (this.seenCommands.has(data.commandId)) return reply(...this.seenCommands.get(data.commandId));
    const signed = canonicalJson({
      sessionId: data.sessionId,
      commandId: data.commandId,
      epoch: data.epoch,
      op: data.op,
      deviceId: attachment.deviceId,
      enc: data.enc,
    });
    if (!verify(signed, data.sig, attachment.identityPub)) return reply(false, null, "bad_signature");
    let args;
    try {
      args = openJson(session.groupKey, data.enc, commandAad({
        sessionId: data.sessionId,
        commandId: data.commandId,
        epoch: data.epoch,
        op: data.op,
        deviceId: attachment.deviceId,
      }));
    } catch {
      return reply(false, null, "decrypt_failed");
    }
    let result;
    try {
      result = await this.commandHandler({ op: data.op, args, sessionId: data.sessionId, deviceId: attachment.deviceId });
    } catch (error) {
      result = { accepted: false, mode: null, error: String(error?.message ?? error) };
    }
    const outcome = [result.accepted === true, result.mode ?? null, result.error ?? null, result.data ?? null];
    this.seenCommands.set(data.commandId, outcome);
    this.seenCommandOrder.push(data.commandId);
    while (this.seenCommandOrder.length > MAX_SEEN_COMMANDS) {
      const oldest = this.seenCommandOrder.shift();
      if (oldest !== undefined) this.seenCommands.delete(oldest);
    }
    return reply(...outcome);
  }

  close() {
    this.socket?.close();
  }
}
