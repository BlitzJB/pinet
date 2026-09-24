import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockGoogleIdp } from "../../src/auth/google.mjs";
import { createCoordinator } from "../../src/coordinator/server.mjs";
import { totp } from "../../src/crypto/totp.mjs";

let idp;
let coord;

beforeAll(async () => {
  idp = await startMockGoogleIdp();
  coord = await createCoordinator({
    config: {
      port: 0,
      host: "127.0.0.1",
      sessionSecret: "account-ui-secret",
      serverId: "srv_account_ui",
      google: { clientId: "cid", clientSecret: "csec", authUrl: idp.authUrl, tokenUrl: idp.tokenUrl, userinfoUrl: idp.userinfoUrl },
    },
  });
});

afterAll(async () => {
  await coord.close();
  await idp.close();
});

async function loginToken(n) {
  idp.setUser({ sub: `ui-${n}`, email: `ui${n}@example.com`, name: `UI ${n}` });
  const start = await fetch(`${coord.httpUrl}/auth/login`, { redirect: "manual" });
  const authorized = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = authorized.headers.get("location");
  const response = await fetch(callback, { redirect: "manual", headers: { accept: "application/json" } });
  return (await response.json()).sessionToken;
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

describe("account + MFA setup pages", () => {
  it("redirects anonymous visitors to login", async () => {
    const response = await fetch(`${coord.httpUrl}/`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/auth/login");

    const setup = await fetch(`${coord.httpUrl}/auth/mfa/setup`, { redirect: "manual" });
    expect(setup.status).toBe(302);
    expect(setup.headers.get("location")).toContain("/auth/login");
  });

  it("shows the account page and enrolls an authenticator app", async () => {
    const token = await loginToken(1);

    const home = await fetch(`${coord.httpUrl}/`, { headers: bearer(token) });
    const html = await home.text();
    expect(html).toContain("ui1@example.com");
    expect(html).toContain("not set up");

    const setup = await fetch(`${coord.httpUrl}/auth/mfa/setup`, { headers: bearer(token) });
    const setupHtml = await setup.text();
    const secret = setupHtml.match(/otpauth:\/\/totp\/[^"]*secret=([A-Z2-7]+)/u)?.[1];
    expect(secret, "otpauth secret must be present on the page").toBeTruthy();
    expect(setupHtml).toContain("<svg"); // QR code
    expect(setupHtml).toContain("Recovery codes");

    // Reloading keeps the same secret (QR stays valid) and reissues codes.
    const setup2 = await fetch(`${coord.httpUrl}/auth/mfa/setup`, { headers: bearer(token) });
    const setup2Html = await setup2.text();
    expect(setup2Html).toContain("Recovery codes");
    expect(setup2Html.match(/secret=([A-Z2-7]+)/u)[1]).toBe(secret);

    const activate = await fetch(`${coord.httpUrl}/auth/mfa/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token), accept: "application/json" },
      body: JSON.stringify({ code: totp(secret) }),
    });
    expect(await activate.json()).toEqual({ ok: true });

    const me = await fetch(`${coord.httpUrl}/me`, { headers: bearer(token) });
    expect((await me.json()).mfaEnrolled).toBe(true);

    const setupAgain = await fetch(`${coord.httpUrl}/auth/mfa/setup`, { headers: bearer(token) });
    expect(await setupAgain.text()).toContain("already enrolled");
  });

  it("requires MFA on the next login after enrollment", async () => {
    const token = await loginToken(2);
    const setup = await fetch(`${coord.httpUrl}/auth/mfa/setup`, { headers: bearer(token) });
    const secret = (await setup.text()).match(/secret=([A-Z2-7]+)/u)[1];
    await fetch(`${coord.httpUrl}/auth/mfa/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ code: totp(secret) }),
    });

    const next = await loginToken(2); // logs in again; now must be pending
    expect(next).toBeUndefined();
  });
});
