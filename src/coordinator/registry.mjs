// Coordinator routing state. Pure data + lookups; all authorization checks
// live at the WebSocket gateway so this stays easy to test.
//
// Design note: a device identity (hostId) identifies a *machine*, but a machine
// may run several pi processes concurrently. So hosts are keyed by their
// connection (ws), and each session points at the connection that opened it.

import { randomUUID } from "node:crypto";

export class Registry {
  constructor() {
    this.hosts = new Map(); // ws -> { deviceId, accountId, hostName, agent, sessions:Set, connected }
    this.sessions = new Map(); // sessionId -> { hostWs, hostDeviceId, accountId, meta, epoch, subscribers:Set }
    this.controllers = new Map(); // ws -> { role, deviceId, accountId, attachments:Map<sessionId, attachment> }
    this.attachments = new Map(); // attachmentId -> { ws, sessionId }
  }

  registerHost(ws, { deviceId, accountId, hostName, agent }) {
    this.hosts.set(ws, {
      ws,
      deviceId,
      accountId,
      hostName: hostName ?? deviceId,
      agent: agent ?? null,
      sessions: new Set(),
      connected: true,
    });
    this.controllers.set(ws, { role: "host", deviceId, accountId, attachments: new Map() });
  }

  unregisterHost(ws) {
    const host = this.hosts.get(ws);
    if (host) {
      for (const sessionId of host.sessions) {
        const session = this.sessions.get(sessionId);
        if (!session || session.hostWs !== ws) continue;
        session.hostWs = undefined;
        for (const sub of session.subscribers) sendRaw(sub, "session.host", { sessionId, online: false });
      }
      this.hosts.delete(ws);
    }
    this.controllers.delete(ws);
  }

  registerController(ws, { deviceId, accountId }) {
    this.controllers.set(ws, { role: "controller", deviceId, accountId, attachments: new Map() });
  }

  unregisterController(ws) {
    const info = this.controllers.get(ws);
    if (info?.role === "controller") {
      for (const sessionId of info.attachments.keys()) {
        const session = this.sessions.get(sessionId);
        if (session) session.subscribers.delete(ws);
      }
    }
    this.controllers.delete(ws);
  }

  openSession(ws, { sessionId, meta }) {
    const info = this.controllers.get(ws);
    if (!info || info.role !== "host") return undefined;
    const host = this.hosts.get(ws);
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        hostWs: ws,
        hostDeviceId: info.deviceId,
        accountId: info.accountId,
        meta: meta ?? {},
        epoch: 0,
        subscribers: new Set(),
      };
      this.sessions.set(sessionId, session);
    } else if (session.accountId !== info.accountId) {
      // A different account must never rebind or observe this session id.
      return undefined;
    } else {
      // Same account: last host to open a given session id wins; fence the
      // previous owner.
      session.hostWs = ws;
      session.hostDeviceId = info.deviceId;
      session.meta = meta ?? session.meta;
    }
    host?.sessions.add(sessionId);
    return session;
  }

  closeSession(sessionId, ws) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (ws !== undefined && session.hostWs !== ws) return false;
    for (const sub of session.subscribers) sendRaw(sub, "session.removed", { sessionId, reason: "closed" });
    if (session.hostWs) this.hosts.get(session.hostWs)?.sessions.delete(sessionId);
    this.sessions.delete(sessionId);
    return true;
  }

  /** The live host connection currently owning a session, if any. */
  hostFor(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.hostWs) return undefined;
    const host = this.hosts.get(session.hostWs);
    return host?.connected ? host : undefined;
  }

  ownsSession(ws, sessionId) {
    const session = this.sessions.get(sessionId);
    return Boolean(session && session.hostWs === ws);
  }

  subscribers(sessionId) {
    return this.sessions.get(sessionId)?.subscribers ?? new Set();
  }

  attach(ws, sessionId, mode) {
    const info = this.controllers.get(ws);
    if (!info || info.role !== "controller") return undefined;
    const session = this.sessions.get(sessionId);
    if (!session || session.accountId !== info.accountId) return undefined;
    const existing = info.attachments.get(sessionId);
    if (existing) return existing;
    const attachment = { attachmentId: `att_${randomUUID().slice(0, 8)}`, sessionId, mode, deviceId: info.deviceId, ws };
    info.attachments.set(sessionId, attachment);
    this.attachments.set(attachment.attachmentId, attachment);
    session.subscribers.add(ws);
    return attachment;
  }

  /** Every controller attachment to a session, so a (re)connecting host can re-key them. */
  attachmentsFor(sessionId) {
    const out = [];
    for (const info of this.controllers.values()) {
      if (info.role !== "controller") continue;
      const attachment = info.attachments.get(sessionId);
      if (attachment) out.push({ attachment, info });
    }
    return out;
  }

  detach(ws, sessionId) {
    const info = this.controllers.get(ws);
    if (!info) return;
    const attachment = info.attachments.get(sessionId);
    if (!attachment) return;
    info.attachments.delete(sessionId);
    this.attachments.delete(attachment.attachmentId);
    this.sessions.get(sessionId)?.subscribers.delete(ws);
  }

  getAttachment(attachmentId) {
    return this.attachments.get(attachmentId);
  }

  catalog(accountId) {
    const out = [];
    for (const session of this.sessions.values()) {
      if (session.accountId !== accountId) continue;
      const host = session.hostWs ? this.hosts.get(session.hostWs) : undefined;
      out.push({
        sessionId: session.sessionId,
        hostId: host?.deviceId ?? session.hostDeviceId,
        hostName: host?.hostName ?? null,
        hostConnected: Boolean(host?.connected),
        meta: session.meta,
        epoch: session.epoch,
      });
    }
    return out;
  }

  /** Counts for diagnostics. */
  stats() {
    return { hosts: this.hosts.size, controllers: this.controllers.size, sessions: this.sessions.size, attachments: this.attachments.size };
  }
}

function sendRaw(ws, type, data) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ v: 1, id: randomUUID(), type, ts: Date.now(), data }));
}
