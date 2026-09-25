import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/common/canonical.mjs";
import { PinetSocket } from "../../src/common/ws-client.mjs";
import { generateEd25519, sign } from "../../src/crypto/keys.mjs";
import { enrollDevice, makeAccount, startCoordinator } from "../helpers/harness.mjs";

let coord;
let account;

beforeEach(async () => {
  coord = await startCoordinator();
  account = makeAccount(coord.accounts, "auth@example.com");
});

afterEach(async () => {
  await coord.close();
});

function connectOnce({ role, deviceId, privateKey }) {
  const socket = new PinetSocket(coord.url);
  return socket.connect({ role, deviceId, identityPrivateKey: privateKey, timeoutMs: 3000 });
}

describe("WebSocket device authentication", () => {
  it("accepts a correctly signed challenge", async () => {
    const { device, identity } = enrollDevice(coord.accounts, account.id, "controller", "ok");
    const auth = await connectOnce({ role: "controller", deviceId: device.id, privateKey: identity.privateKey });
    expect(auth).toMatchObject({ deviceId: device.id, accountId: account.id });
  });

  it("rejects a signature from the wrong key", async () => {
    const { device } = enrollDevice(coord.accounts, account.id, "controller", "bad-key");
    const attacker = generateEd25519();
    await expect(connectOnce({ role: "controller", deviceId: device.id, privateKey: attacker.privateKey })).rejects.toThrow();
  });

  it("rejects a device used with the wrong role", async () => {
    const { device, identity } = enrollDevice(coord.accounts, account.id, "host", "host-role");
    await expect(connectOnce({ role: "controller", deviceId: device.id, privateKey: identity.privateKey })).rejects.toThrow();
  });

  it("rejects a revoked device", async () => {
    const { device, identity } = enrollDevice(coord.accounts, account.id, "controller", "revoked");
    coord.accounts.revokeDevice(device.id);
    await expect(connectOnce({ role: "controller", deviceId: device.id, privateKey: identity.privateKey })).rejects.toThrow();
  });

  it("rejects a stale challenge timestamp", async () => {
    const { device, identity } = enrollDevice(coord.accounts, account.id, "controller", "stale");
    const ws = new WebSocket(coord.url);
    const challenge = await new Promise((resolve) => {
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "auth.challenge") resolve(msg.data);
      });
    });
    const timestamp = Date.now() - 120_000;
    const payload = canonicalJson({ nonce: challenge.nonce, serverId: coord.serverId, timestamp, role: "controller", deviceId: device.id });
    const errorPromise = new Promise((resolve) => {
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "auth.error") resolve(msg.data);
      });
    });
    ws.send(
      JSON.stringify({
        v: 1,
        id: "manual",
        type: "hello",
        ts: Date.now(),
        data: { role: "controller", deviceId: device.id, timestamp, signature: sign(payload, identity.privateKey) },
      }),
    );
    const error = await errorPromise;
    expect(error.code).toBe("stale");
    ws.close();
  });

  it("rejects a hello replayed on a different challenge", async () => {
    const { device, identity } = enrollDevice(coord.accounts, account.id, "controller", "replay");
    // Capture a valid hello from connection 1.
    const first = new WebSocket(coord.url);
    const challenge1 = await new Promise((resolve) => {
      first.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "auth.challenge") resolve(msg.data);
      });
    });
    const timestamp = Date.now();
    const payload1 = canonicalJson({ nonce: challenge1.nonce, serverId: coord.serverId, timestamp, role: "controller", deviceId: device.id });
    const hello = { role: "controller", deviceId: device.id, timestamp, signature: sign(payload1, identity.privateKey) };
    first.close();

    // Replay the signed hello on a fresh connection (new nonce) must fail.
    const second = new WebSocket(coord.url);
    await new Promise((resolve) => {
      second.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "auth.challenge") resolve();
      });
    });
    const errorPromise = new Promise((resolve) => {
      second.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "auth.error") resolve(msg.data);
      });
    });
    second.send(JSON.stringify({ v: 1, id: "replay", type: "hello", ts: Date.now(), data: hello }));
    expect((await errorPromise).code).toBe("bad_signature");
    second.close();
  });
});

describe("browser session vs controller device account", () => {
  it("rejects a connection whose cookie belongs to a different account", async () => {
    const coord2 = await startCoordinator({
      verifySession: (token) => (token.startsWith("tok:") ? { accountId: token.slice(4) } : null),
    });
    try {
      const owner = makeAccount(coord2.accounts, "owner@example.com");
      const other = makeAccount(coord2.accounts, "other@example.com");
      const { device, identity } = enrollDevice(coord2.accounts, owner.id, "controller", "browser");
      const socket = new PinetSocket(coord2.url);
      await expect(
        socket.connect({
          role: "controller",
          deviceId: device.id,
          identityPrivateKey: identity.privateKey,
          timeoutMs: 3000,
          headers: { cookie: `pinet_session=tok:${other.id}` },
        }),
      ).rejects.toThrow();
      socket.close();

      // Same device, cookie for the account it belongs to: accepted.
      const ok = new PinetSocket(coord2.url);
      const auth = await ok.connect({
        role: "controller",
        deviceId: device.id,
        identityPrivateKey: identity.privateKey,
        timeoutMs: 3000,
        headers: { cookie: `pinet_session=tok:${owner.id}` },
      });
      expect(auth).toMatchObject({ deviceId: device.id, accountId: owner.id });
      ok.close();
    } finally {
      await coord2.close();
    }
  });
});
