import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountStore } from "../../src/auth/accounts.mjs";
import { GoogleOAuth, startMockGoogleIdp } from "../../src/auth/google.mjs";
import { AuthService } from "../../src/auth/service.mjs";
import { totp } from "../../src/crypto/totp.mjs";

let idp;
let accounts;
let service;

beforeAll(async () => {
  idp = await startMockGoogleIdp();
  accounts = new AccountStore();
  const google = new GoogleOAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1/callback",
    authUrl: idp.authUrl,
    tokenUrl: idp.tokenUrl,
    userinfoUrl: idp.userinfoUrl,
  });
  service = new AuthService({ accounts, google, sessionSecret: "session-secret" });
});

afterAll(async () => {
  await idp.close();
});

async function driveBrowserLogin() {
  const { url, state } = service.startLogin({ returnTo: "/app" });
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  const redirected = new URL(location);
  return { code: redirected.searchParams.get("code"), state: redirected.searchParams.get("state"), expectedState: state };
}

async function login() {
  const { code, state, expectedState } = await driveBrowserLogin();
  expect(state).toBe(expectedState);
  return service.handleCallback({ code, state });
}

describe("Google SSO + MFA login flow", () => {
  it("logs in without MFA and issues a usable session", async () => {
    const result = await login();
    expect(result.mfaRequired).toBe(false);
    const session = service.verifySession(result.sessionToken);
    expect(session.accountId).toBe(result.accountId);
    expect(session.mfa).toBe(true);
  });

  it("requires MFA after enrollment and blocks the pending token", async () => {
    const first = await login();
    const { secret } = service.enrollMfa(first.accountId);
    expect(service.activateMfa(first.accountId, totp(secret))).toBe(true);

    const second = await login();
    expect(second.mfaRequired).toBe(true);
    expect(second.sessionToken).toBeNull();
    expect(service.verifySession(second.pendingToken)).toBeNull();

    const completed = service.completeMfa({ pendingToken: second.pendingToken, code: totp(secret) });
    const session = service.verifySession(completed.sessionToken);
    expect(session.accountId).toBe(first.accountId);
  });

  it("rejects a reused TOTP counter", async () => {
    const first = await login();
    const { secret } = service.enrollMfa(first.accountId);
    service.activateMfa(first.accountId, totp(secret));
    const pending = await login();
    const code = totp(secret);
    service.completeMfa({ pendingToken: pending.pendingToken, code });
    const pending2 = await login();
    expect(() => service.completeMfa({ pendingToken: pending2.pendingToken, code })).toThrow(/invalid MFA code/);
  });

  it("accepts a recovery code exactly once", async () => {
    const first = await login();
    const { secret, recoveryCodes } = service.enrollMfa(first.accountId);
    service.activateMfa(first.accountId, totp(secret));

    const pending = await login();
    const completed = service.completeMfa({ pendingToken: pending.pendingToken, recoveryCode: recoveryCodes[0] });
    expect(service.verifySession(completed.sessionToken)).not.toBeNull();

    const pending2 = await login();
    expect(() => service.completeMfa({ pendingToken: pending2.pendingToken, recoveryCode: recoveryCodes[0] })).toThrow();
  });

  it("rejects an unknown or expired OAuth state", async () => {
    await expect(service.handleCallback({ code: "x", state: "nope" })).rejects.toThrow(/invalid or expired/);
  });
});
