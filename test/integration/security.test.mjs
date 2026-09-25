import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockGoogleIdp } from "../../src/auth/google.mjs";
import { verifyToken } from "../../src/auth/tokens.mjs";
import { createCoordinator } from "../../src/coordinator/server.mjs";

const SECRET = "security-suite-secret";
let idp;
let coord;

beforeAll(async () => {
  idp = await startMockGoogleIdp();
  coord = await createCoordinator({
    config: {
      port: 0,
      host: "127.0.0.1",
      sessionSecret: SECRET,
      serverId: "srv_security",
      google: { clientId: "cid", clientSecret: "csec", authUrl: idp.authUrl, tokenUrl: idp.tokenUrl, userinfoUrl: idp.userinfoUrl },
    },
  });
});

afterAll(async () => {
  await coord.close();
  await idp.close();
});

async function loginToken(n) {
  idp.setUser({ sub: `sec-${n}`, email: `sec${n}@example.com`, name: `Sec ${n}` });
  const start = await fetch(`${coord.httpUrl}/auth/login`, { redirect: "manual" });
  const authorized = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = authorized.headers.get("location");
  const response = await fetch(callback, { redirect: "manual", headers: { accept: "application/json" } });
  return (await response.json()).sessionToken;
}

describe("security hardening", () => {
  it("escapes the MFA page query params (no reflected XSS)", async () => {
    const payload = "%3Cscript%3Ealert(1)%3C%2Fscript%3E";
    const response = await fetch(`${coord.httpUrl}/auth/mfa?pending=${payload}&return_to=${payload}`);
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sets hardening + CSP headers", async () => {
    const response = await fetch(`${coord.httpUrl}/health`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("rejects oversized bodies with 413", async () => {
    const response = await fetch(`${coord.httpUrl}/auth/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: "x".repeat(100_000) }),
    });
    expect(response.status).toBe(413);
  });

  it("rejects malformed public keys with 400", async () => {
    const token = await loginToken(1);
    const response = await fetch(`${coord.httpUrl}/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "controller", name: "x", identityPub: "not-a-key", encPub: "nope" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_keys");
  });

  it("uses a one-time code for loopback CLI login (no token in the URL)", async () => {
    idp.setUser({ sub: "sec-cli", email: "sec-cli@example.com", name: "CLI" });
    const returnTo = "http://127.0.0.1:9999/";
    const start = await fetch(`${coord.httpUrl}/auth/login?return_to=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
    const authorized = await fetch(start.headers.get("location"), { redirect: "manual" });
    const response = await fetch(authorized.headers.get("location"), { redirect: "manual" });
    const location = response.headers.get("location");
    expect(location).toContain("http://127.0.0.1:9999/?code=");
    expect(location).not.toContain("session_token");

    const code = new URL(location).searchParams.get("code");
    const exchange = await fetch(`${coord.httpUrl}/auth/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(exchange.status).toBe(200);
    expect(typeof (await exchange.json()).sessionToken).toBe("string");

    // single-use
    const reuse = await fetch(`${coord.httpUrl}/auth/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(reuse.status).toBe(400);
  });

  it("reports the real MFA claim on session tokens", async () => {
    const token = await loginToken(2);
    expect(verifyToken(token, SECRET).mfa).toBe(false);

    const enroll = await fetch(`${coord.httpUrl}/auth/mfa/enroll`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const { secret } = await enroll.json();
    const { totp } = await import("../../src/crypto/totp.mjs");
    await fetch(`${coord.httpUrl}/auth/mfa/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: totp(secret) }),
    });

    // Next login is pending; complete MFA and inspect the claim.
    const start = await fetch(`${coord.httpUrl}/auth/login`, { redirect: "manual" });
    const authorized = await fetch(start.headers.get("location"), { redirect: "manual" });
    const callback = authorized.headers.get("location");
    const pending = await (await fetch(callback, { redirect: "manual", headers: { accept: "application/json" } })).json();
    const verified = await fetch(`${coord.httpUrl}/auth/mfa/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ pending: pending.pendingToken, code: totp(secret) }),
    });
    const { sessionToken } = await verified.json();
    expect(verifyToken(sessionToken, SECRET).mfa).toBe(true);
  });
});
