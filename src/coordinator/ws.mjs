// Authenticated WebSocket gateway. Verifies device proof-of-possession, then
// routes opaque (end-to-end encrypted) session frames and commands. The
// coordinator never sees plaintext session content or command arguments.

import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { canonicalJson } from "../common/canonical.mjs";
import { newNonce } from "../common/ids.mjs";
import { verify } from "../crypto/keys.mjs";
import { Registry } from "./registry.mjs";

const CHALLENGE_TIMEOUT_MS = 15_000;
const MAX_CLOCK_SKEW_MS = 60_000;

function send(ws, type, data = {}, route) {
  if (ws?.readyState !== 1) return;
  const msg = { v: 1, id: randomUUID(), type, ts: Date.now(), data };
  if (route) msg.route = route;
  ws.send(JSON.stringify(msg));
}

export function createGateway({ server, accounts, serverId, now = Date.now, registry = new Registry() }) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const pendingCommands = new Map(); // commandId -> controller ws
  const state = new WeakMap(); // ws -> auth state

  wss.on("connection", (ws) => {
    const auth = { stage: "challenge", nonce: newNonce(), device: null, role: null, accountId: null };
    state.set(ws, auth);
    send(ws, "auth.challenge", { nonce: auth.nonce, serverId, ts: now() });

    const timer = setTimeout(() => {
      if (auth.stage !== "ready") ws.close(4001, "auth timeout");
    }, CHALLENGE_TIMEOUT_MS);
    timer.unref?.();

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, "error", { code: "bad_json", message: "could not parse message" });
        return;
      }
      try {
        handle(ws, msg, auth);
      } catch (error) {
        send(ws, "error", { code: "internal", message: String(error?.message ?? error) });
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      const current = state.get(ws);
      if (current?.stage === "ready") {
        if (current.role === "host") registry.unregisterHost(ws);
        else registry.unregisterController(ws);
        console.log(`[hub] ${current.role} disconnected ${current.deviceId}`, registry.stats());
      }
    });
  });

  function handle(ws, msg, auth) {
    if (auth.stage === "challenge") {
      if (msg.type !== "hello") {
        send(ws, "error", { code: "handshake_required", message: "hello required" });
        ws.close(4001, "handshake required");
        return;
      }
      return authenticate(ws, msg.data ?? {}, auth);
    }

    const data = msg.data ?? {};
    const route = msg.route ?? {};
    if (msg.type === "ping") {
      send(ws, "pong", {});
      return;
    }
    if (auth.role === "host") return handleHost(ws, msg.type, data, route, auth);
    if (auth.role === "controller") return handleController(ws, msg.type, data, route, auth);
  }

  function authenticate(ws, data, auth) {
    const { role, deviceId, signature, timestamp } = data;
    if (role !== "host" && role !== "controller") throw new Error("invalid role");
    const device = accounts.getDevice(deviceId);
    if (!device || device.revoked || device.kind !== role) {
      send(ws, "auth.error", { code: "unauthorized", message: "unknown or revoked device" });
      ws.close(4003, "unauthorized");
      return;
    }
    if (typeof timestamp !== "number" || Math.abs(now() - timestamp) > MAX_CLOCK_SKEW_MS) {
      send(ws, "auth.error", { code: "stale", message: "challenge timestamp out of range" });
      ws.close(4003, "stale challenge");
      return;
    }
    const payload = canonicalJson({ nonce: auth.nonce, serverId, timestamp, role, deviceId });
    if (typeof signature !== "string" || !verify(payload, signature, device.identityPub)) {
      send(ws, "auth.error", { code: "bad_signature", message: "challenge signature invalid" });
      ws.close(4003, "bad signature");
      return;
    }
    auth.stage = "ready";
    auth.device = device;
    auth.deviceId = deviceId;
    auth.role = role;
    auth.accountId = device.accountId;
    if (role === "host") {
      registry.registerHost(ws, { deviceId, accountId: device.accountId, hostName: device.name, agent: data.agent ?? null });
    } else {
      registry.registerController(ws, { deviceId, accountId: device.accountId });
    }
    console.log(`[hub] ${role} connected ${deviceId} (${device.name})`, registry.stats());
    send(ws, "auth.ok", { deviceId, accountId: device.accountId, serverId, role });
    broadcastCatalog(device.accountId);
  }

  function broadcastCatalog(accountId) {
    const catalog = registry.catalog(accountId);
    for (const [ws, info] of registry.controllers) {
      if (info.role === "controller" && info.accountId === accountId) send(ws, "ctl.catalog", { sessions: catalog });
    }
  }

  function handleHost(ws, type, data, route, auth) {
    switch (type) {
      case "host.heartbeat":
        return;
      case "session.opened": {
        const session = registry.openSession(ws, data);
        if (session) broadcastCatalog(auth.accountId);
        return;
      }
      case "session.closed": {
        registry.closeSession(data.sessionId);
        broadcastCatalog(auth.accountId);
        return;
      }
      case "session.snapshot":
      case "session.rebase":
      case "session.entries":
      case "session.status":
      case "session.meta": {
        const sessionId = route.sessionId ?? data.sessionId;
        const session = registry.sessions.get(sessionId);
        if (!session || !registry.ownsSession(ws, sessionId)) return;
        const epoch = route.epoch ?? data.epoch ?? 0;
        session.epoch = epoch;
        const msg = { v: 1, id: randomUUID(), type, ts: Date.now(), route: { sessionId, epoch }, data };
        const text = JSON.stringify(msg);
        for (const sub of session.subscribers) if (sub.readyState === 1) sub.send(text);
        return;
      }
      case "e2e.key": {
        const attachment = registry.getAttachment(data.attachmentId);
        if (!attachment || attachment.sessionId !== data.sessionId) return;
        send(attachment.ws, "e2e.key", data, { sessionId: data.sessionId, epoch: data.epoch });
        return;
      }
      case "cmd.ack": {
        const controllerWs = pendingCommands.get(data.commandId);
        if (!controllerWs) return;
        pendingCommands.delete(data.commandId);
        send(controllerWs, "cmd.ack", data);
        return;
      }
      case "host.attached":
      case "host.detached":
        return;
      default:
        send(ws, "error", { code: "unknown_type", message: `unknown host type ${type}` });
    }
  }

  function handleController(ws, type, data, route, auth) {
    switch (type) {
      case "ctl.list":
        send(ws, "ctl.catalog", { sessions: registry.catalog(auth.accountId) });
        return;
      case "ctl.attach": {
        const session = registry.sessions.get(data.sessionId);
        if (!session || session.accountId !== auth.accountId) {
          send(ws, "error", { code: "no_session", message: "unknown session" });
          return;
        }
        const mode = data.mode === "read" ? "read" : "control";
        const attachment = registry.attach(ws, data.sessionId, mode);
        send(ws, "ctl.attached", { sessionId: data.sessionId, attachmentId: attachment.attachmentId, mode, epoch: session.epoch });
        const host = registry.hostFor(data.sessionId);
        if (host) {
          send(host.ws, "host.attach", {
            sessionId: data.sessionId,
            attachmentId: attachment.attachmentId,
            mode,
            controller: { deviceId: auth.deviceId, identityPub: auth.device.identityPub, encPub: auth.device.encPub },
          });
        }
        return;
      }
      case "ctl.detach": {
        const info = registry.controllers.get(ws);
        const attachment = info?.attachments.get(data.sessionId);
        registry.detach(ws, data.sessionId);
        const host = registry.hostFor(data.sessionId);
        if (host && attachment) send(host.ws, "host.detach", { sessionId: data.sessionId, attachmentId: attachment.attachmentId });
        return;
      }
      case "ctl.command": {
        const info = registry.controllers.get(ws);
        const attachment = info?.attachments.get(data.sessionId);
        if (!attachment) {
          send(ws, "cmd.ack", { commandId: data.commandId, accepted: false, mode: null, error: "not_attached" });
          return;
        }
        if (attachment.mode !== "control") {
          send(ws, "cmd.ack", { commandId: data.commandId, accepted: false, mode: null, error: "read_only" });
          return;
        }
        const session = registry.sessions.get(data.sessionId);
        const host = registry.hostFor(data.sessionId);
        if (!session || !host) {
          send(ws, "cmd.ack", { commandId: data.commandId, accepted: false, mode: null, error: "host_unavailable" });
          return;
        }
        pendingCommands.set(data.commandId, ws);
        send(host.ws, "cmd.deliver", {
          sessionId: data.sessionId,
          attachmentId: attachment.attachmentId,
          epoch: data.epoch ?? session.epoch,
          commandId: data.commandId,
          op: data.op,
          enc: data.enc,
          sig: data.sig,
          deviceId: auth.deviceId,
        });
        return;
      }
      default:
        send(ws, "error", { code: "unknown_type", message: `unknown controller type ${type}` });
    }
  }

  return {
    wss,
    registry,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
