import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockGoogleIdp } from "../../src/auth/google.mjs";
import { createCoordinator } from "../../src/coordinator/server.mjs";
import { PinetSocket } from "../../src/common/ws-client.mjs";
import { totp } from "../../src/crypto/totp.mjs";
import { generateEd25519, generateX25519 } from "../../src/crypto/keys.mjs";

let idp;
let coord;

beforeAll(async () => {
  idp = await startMockGoogleIdp();
  coord = await createCoordinator({
    config: {
      port: 0,
      host: "127.0.0.1",
      sessionSecret: "test-session-secret",
      serverId: "srv_http_test",
      google: { clientId: "cid", clientSecret: "csec", authUrl: idp.authUrl, tokenUrl: idp.tokenUrl, userinfoUrl: idp.userinfoUrl },
    },
  });
});

afterAll(async () => {
  await coord.close();
  await idp.close();
});

async function loginJson() {
  const start = await fetch(`${coord.httpUrl}/auth/login`, { redirect: "manual" });
  const googleUrl = start.headers.get("location");
  const authorized = await fetch(googleUrl, { redirect: "manual" });
  const callback = authorized.headers.get("location");
  const response = await fetch(callback, { redirect: "manual", headers: { accept: "application/json" } });
  return response.json();
}

function useUser(n) {
  idp.setUser({ sub: `sub-${n}`, email: `u${n}@example.com`, name: `User ${n}` });
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("HTTP auth surface", () => {
  it("serves health", async () => {
    const res = await fetch(`${coord.httpUrl}/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("completes Google SSO and exposes the account", async () => {
    useUser(1);
    const body = await loginJson();
    expect(body.mfaRequired).toBe(false);
    expect(typeof body.sessionToken).toBe("string");
    const me = await fetch(`${coord.httpUrl}/me`, { headers: authHeaders(body.sessionToken) });
    const profile = await me.json();
    expect(profile.email).toBe("u1@example.com");
    expect(profile.mfaEnrolled).toBe(false);
  });

  it("rejects unauthenticated access to protected routes", async () => {
    const res = await fetch(`${coord.httpUrl}/me`);
    expect(res.status).toBe(401);
  });

  it("enrolls MFA and requires it on the next login", async () => {
    useUser(2);
    const first = await loginJson();
    const enroll = await fetch(`${coord.httpUrl}/auth/mfa/enroll`, {
      method: "POST",
      headers: authHeaders(first.sessionToken),
    });
    const { secret, uri, recoveryCodes } = await enroll.json();
    expect(uri).toContain("otpauth://totp/");
    expect(recoveryCodes).toHaveLength(10);

    const activate = await fetch(`${coord.httpUrl}/auth/mfa/activate`, {
      method: "POST",
      headers: authHeaders(first.sessionToken),
      body: JSON.stringify({ code: totp(secret) }),
    });
    expect(await activate.json()).toEqual({ ok: true });

    const second = await loginJson();
    expect(second.mfaRequired).toBe(true);
    expect(second.sessionToken).toBeUndefined();

    const verify = await fetch(`${coord.httpUrl}/auth/mfa/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ pending: second.pendingToken, code: totp(secret) }),
    });
    const verified = await verify.json();
    const me = await fetch(`${coord.httpUrl}/me`, { headers: authHeaders(verified.sessionToken) });
    expect((await me.json()).mfaEnrolled).toBe(true);
  });

  it("registers a controller device via HTTP and authenticates it over WS", async () => {
    useUser(3);
    const { sessionToken } = await loginJson();
    const identity = generateEd25519();
    const encryption = generateX25519();
    const registered = await fetch(`${coord.httpUrl}/devices/register`, {
      method: "POST",
      headers: authHeaders(sessionToken),
      body: JSON.stringify({ kind: "controller", name: "test-phone", identityPub: identity.publicKey, encPub: encryption.publicKey }),
    });
    const { deviceId } = await registered.json();
    expect(deviceId).toMatch(/^dev_/u);

    const socket = new PinetSocket(coord.wsUrl);
    const auth = await socket.connect({ role: "controller", deviceId, identityPrivateKey: identity.privateKey });
    expect(auth).toMatchObject({ deviceId, role: "controller" });
    socket.close();
  });

  it("enrolls a host with a one-time code", async () => {
    useUser(4);
    const { sessionToken } = await loginJson();
    const start = await fetch(`${coord.httpUrl}/hosts/enroll/start`, { method: "POST", headers: authHeaders(sessionToken) });
    const { code } = await start.json();
    const identity = generateEd25519();
    const encryption = generateX25519();
    const enroll = await fetch(`${coord.httpUrl}/hosts/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "studio", identityPub: identity.publicKey, encPub: encryption.publicKey }),
    });
    const { hostId } = await enroll.json();
    expect(hostId).toMatch(/^host_/u);

    // Reuse must fail.
    const reuse = await fetch(`${coord.httpUrl}/hosts/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "again", identityPub: identity.publicKey, encPub: encryption.publicKey }),
    });
    expect(reuse.status).toBe(400);
  });
});
