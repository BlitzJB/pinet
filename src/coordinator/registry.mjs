// Coordinator routing state. Pure data + lookups; all authorization checks
// live at the WebSocket gateway so this stays easy to test.

import { randomUUID } from "node:crypto";

export class Registry {
  constructor() {
    this.hosts = new Map(); // hostId -> { ws, accountId, hostName, agent, sessions:Set, connected }
    this.sessions = new Map(); // sessionId -> { hostId, accountId, meta, epoch, subscribers:Set }
    this.controllers = new Map(); // ws -> { deviceId, accountId, attachments:Map<sessionId, attachment> }
    this.attachments = new Map(); // attachmentId -> { ws, sessionId }
  }

  registerHost(ws, { deviceId, accountId, hostName, agent }) {
    this.hosts.set(deviceId, { ws, deviceId, accountId, hostName: hostName ?? deviceId, agent: agent ?? null, sessions: new Set(), connected: true });
    this.controllers.set(ws, { role: "host", deviceId, accountId, attachments: new Map() });
  }

  unregisterHost(ws) {
    const info = this.controllers.get(ws);
    if (info?.role === "host") {
      const host = this.hosts.get(info.deviceId);
      if (host && host.ws === ws) {
        host.connected = false;
        for (const sessionId of host.sessions) {
          const session = this.sessions.get(sessionId);
          if (session) {
            for (const sub of session.subscribers) {
              sendRaw(sub, "session.host", { sessionId, online: false });
            }
          }
        }
      }
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
        if (!session) continue;
        session.subscribers.delete(ws);
        this.#notifyHostOfAttachments(sessionId, info.attachments);
      }
    }
    this.controllers.delete(ws);
  }

  openSession(ws, { sessionId, meta }) {
    const info = this.controllers.get(ws);
    if (!info || info.role !== "host") return undefined;
    const host = this.hosts.get(info.deviceId);
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { sessionId, hostId: info.deviceId, accountId: info.accountId, meta: meta ?? {}, epoch: 0, subscribers: new Set() };
      this.sessions.set(sessionId, session);
    } else {
      session.hostId = info.deviceId;
      session.meta = meta ?? session.meta;
    }
    host?.sessions.add(sessionId);
    return session;
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const sub of session.subscribers) sendRaw(sub, "session.removed", { sessionId, reason: "closed" });
    this.hosts.get(session.hostId)?.sessions.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  hostFor(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const host = this.hosts.get(session.hostId);
    return host?.connected ? host : undefined;
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
      const host = this.hosts.get(session.hostId);
      out.push({
        sessionId: session.sessionId,
        hostId: session.hostId,
        hostName: host?.hostName ?? session.hostId,
        hostConnected: host?.connected ?? false,
        meta: session.meta,
        epoch: session.epoch,
      });
    }
    return out;
  }

  #notifyHostOfAttachments(sessionId, attachments) {
    const session = this.sessions.get(sessionId);
    const host = session && this.hosts.get(session.hostId);
    if (!host?.connected) return;
    // host is informed implicitly through host.attach/detach messages instead.
  }
}

function sendRaw(ws, type, data) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ v: 1, id: randomUUID(), type, ts: Date.now(), data }));
}
