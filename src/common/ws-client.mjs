// Authenticated client socket shared by hosts and controllers.
// Runtime-agnostic: no Node imports; crypto is injected (defaults to the Node
// provider via dynamic import, so browsers can pass webCryptoProvider instead).
//
// Network resilience: optional automatic reconnection with exponential backoff
// + jitter, plus an application-level heartbeat that detects half-open
// connections (a silently dead network) and forces a reconnect.

import { canonicalJson } from "./canonical.mjs";
import { Emitter } from "./emitter.mjs";

export class PinetSocket extends Emitter {
  constructor(url, { crypto, reconnect = false, minMs = 500, maxMs = 15_000, heartbeatMs = 20_000 } = {}) {
    super();
    this.url = url;
    this.crypto = crypto;
    this.reconnect = reconnect;
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.heartbeatMs = heartbeatMs;
    this.ws = undefined;
    this.ready = false;
    this.waiters = [];
    this.params = undefined;
    this.closedByUser = false;
    this.hasConnected = false;
    this.backoff = minMs;
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    this.lastActivity = 0;
  }

  async connect(params) {
    this.params = params;
    this.closedByUser = false;
    const provider = this.crypto ?? (await import(/* @vite-ignore */ "../crypto/provider.mjs")).nodeCryptoProvider;
    this.crypto = provider;
    return this.#establish();
  }

  readyState() {
    return this.ws?.readyState;
  }

  waitForReady(timeoutMs = 15_000) {
    if (this.ready && this.ws?.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("ready", onReady);
        reject(new Error("not connected"));
      }, timeoutMs);
      timer.unref?.();
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("ready", onReady);
    });
  }

  #establish() {
    const provider = this.crypto;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.lastActivity = Date.now();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("auth handshake timeout"));
        ws.close();
      }, this.params?.timeoutMs ?? 10_000);
      timer.unref?.();

      ws.addEventListener("error", (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(event.error ?? new Error("websocket error"));
        }
      });

      ws.addEventListener("message", (event) => {
        this.lastActivity = Date.now();
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type === "auth.challenge" && !this.ready) {
          void (async () => {
            const timestamp = Date.now();
            const payload = canonicalJson({
              nonce: msg.data.nonce,
              serverId: msg.data.serverId,
              timestamp,
              role: this.params.role,
              deviceId: this.params.deviceId,
            });
            const signature = await provider.sign(payload, this.params.identityPrivateKey);
            this.send("hello", { role: this.params.role, deviceId: this.params.deviceId, timestamp, signature });
          })();
          return;
        }
        if (msg.type === "auth.error" && !this.ready) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(msg.data?.message ?? "authentication failed"));
          }
          ws.close();
          return;
        }
        if (msg.type === "auth.ok" && !this.ready) {
          settled = true;
          clearTimeout(timer);
          this.ready = true;
          this.backoff = this.minMs;
          this.#startHeartbeat();
          this.emit("ready", msg.data);
          if (this.hasConnected) this.emit("reconnected", msg.data);
          else this.hasConnected = true;
          resolve(msg.data);
          return;
        }
        this.emit(msg.type, msg.data ?? {}, msg);
        this.emit("*", msg);
        for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
          const waiter = this.waiters[i];
          if (waiter.type !== msg.type) continue;
          if (waiter.predicate && !waiter.predicate(msg.data ?? {})) continue;
          this.waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(msg.data ?? {});
        }
      });

      ws.addEventListener("close", () => {
        clearTimeout(timer);
        const wasReady = this.ready;
        this.ready = false;
        this.#stopHeartbeat();
        if (wasReady) this.emit("disconnected");
        if (this.closedByUser) {
          this.emit("closed");
        } else if (this.reconnect) {
          this.#scheduleReconnect();
        } else {
          this.emit("closed");
        }
      });
    });
  }

  #scheduleReconnect() {
    if (this.closedByUser || !this.reconnect || this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * Math.min(250, this.backoff));
    const delay = Math.min(this.backoff + jitter, this.maxMs);
    this.backoff = Math.min(this.backoff * 2, this.maxMs);
    this.emit("reconnecting", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.#establish().catch(() => this.#scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.lastActivity = Date.now();
    this.heartbeatTimer = setInterval(() => {
      // No inbound traffic for 2.5 intervals => half-open connection.
      if (Date.now() - this.lastActivity > this.heartbeatMs * 2.5) {
        this.ws?.close();
        return;
      }
      try {
        this.send("ping", {});
      } catch {
        /* not ready */
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  send(type, data = {}, route) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) throw new Error("socket not connected");
    const id = Array.from(this.crypto.randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
    const msg = { v: 1, id, type, ts: Date.now(), data };
    if (route) msg.route = route;
    ws.send(JSON.stringify(msg));
  }

  waitFor(type, { timeoutMs = 10_000, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.#stopHeartbeat();
    this.ws?.close();
  }
}
