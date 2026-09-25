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
const PENDING_COMMAND_TTL_MS = 5 * 60_000;
const MAX_PENDING_COMMANDS = 10_000;

function send(ws, type, data = {}, route) {
  if (ws?.readyState !== 1) return;
  const msg = { v: 1, id: randomUUID(), type, ts: Date.now(), data };
  if (route) msg.route = route;
  ws.send(JSON.stringify(msg));
}

export function createGateway({ server, accounts, serverId, now = Date.now, registry = new Registry(), allowedOrigins = [] }) {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, callback) => {
      const origin = info.origin;
      // Native clients send no Origin header; browser clients must match an
      // allowed origin (defence against cross-site WebSocket hijacking).
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(true);
      callback(false, 403, "forbidden origin");
    },
  });
  const pendingCommands = new Map(); // commandId -> { ws, at }
  const state = new WeakMap(); // ws -> auth state

  const pendingTimer = setInterval(() => {
    const cutoff = now() - PENDING_COMMAND_TTL_MS;
    for (const [id, entry] of pendingCommands) if (entry.at < cutoff) pendingCommands.delete(id);
  }, 60_000);
  pendingTimer.unref?.();
  wss.on("close", () => clearInterval(pendingTimer));

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
      for (const [id, entry] of pendingCommands) if (entry.ws === ws) pendingCommands.delete(id);
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
        if (!session) {
          // Either the connection is not a host, or an existing session with this
          // id belongs to another account. Log it: registrations used to fail here
          // completely silently.
          console.log(`[hub] session.rejected ${data?.sessionId} from ${auth.deviceId}`, registry.stats());
          return;
        }
        broadcastCatalog(auth.accountId);
        // meta.host is the live hostname from the extension (the device name is
        // only what was recorded at enrollment), which distinguishes machines
        // that share a host identity.
        const live = data?.meta ?? {};
        console.log(
          `[hub] session.opened ${session.sessionId} by ${auth.deviceId} host=${live.host ?? "?"} cwd=${live.cwd ?? "?"}`,
          registry.stats(),
        );
        // A host process that restarted has no memory of current attachments, so
        // re-send host.attach for each one; the host wraps the new group key and
        // pushes a fresh snapshot, letting controllers recover without re-attaching.
        for (const { attachment, info } of registry.attachmentsFor(session.sessionId)) {
          const device = accounts.getDevice(info.deviceId);
          if (!device) continue;
          send(ws, "host.attach", {
            sessionId: session.sessionId,
            attachmentId: attachment.attachmentId,
            mode: attachment.mode,
            controller: { deviceId: info.deviceId, identityPub: device.identityPub, encPub: device.encPub },
          });
        }
        return;
      }
      case "session.closed": {
        registry.closeSession(data.sessionId, ws);
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
        if ((type === "session.meta" || type === "session.snapshot") && data.meta !== undefined) session.meta = data.meta;
        const msg = { v: 1, id: randomUUID(), type, ts: Date.now(), route: { sessionId, epoch }, data };
        const text = JSON.stringify(msg);
        for (const sub of session.subscribers) if (sub.readyState === 1) sub.send(text);
        return;
      }
      case "e2e.key": {
        if (!registry.ownsSession(ws, data.sessionId)) return;
        const attachment = registry.getAttachment(data.attachmentId);
        if (!attachment || attachment.sessionId !== data.sessionId) return;
        send(attachment.ws, "e2e.key", data, { sessionId: data.sessionId, epoch: data.epoch });
        return;
      }
      case "cmd.ack": {
        const pending = pendingCommands.get(data.commandId);
        if (!pending) return;
        pendingCommands.delete(data.commandId);
        send(pending.ws, "cmd.ack", data);
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
        const host = registry.hostFor(data.sessionId);
        const hostDevice = host ? accounts.getDevice(host.deviceId) : undefined;
        send(ws, "ctl.attached", {
          sessionId: data.sessionId,
          attachmentId: attachment.attachmentId,
          mode,
          epoch: session.epoch,
          hostId: host?.deviceId ?? session.hostDeviceId,
          hostIdentityPub: hostDevice?.identityPub ?? null,
        });
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
        if (pendingCommands.size >= MAX_PENDING_COMMANDS) {
          send(ws, "cmd.ack", { commandId: data.commandId, accepted: false, mode: null, error: "too_many_pending" });
          return;
        }
        pendingCommands.set(data.commandId, { ws, at: now() });
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
