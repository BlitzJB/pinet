// Authentication flow: Google SSO -> MFA -> full session.
// Pure logic, no HTTP. The HTTP layer is a thin adapter over this.

import { randomBytes } from "node:crypto";
import { newNonce } from "../common/ids.mjs";
import { pkcePair } from "./google.mjs";
import { issueToken, verifyToken } from "./tokens.mjs";

const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateUserCode() {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
    if (i === 3) out += "-";
  }
  return out;
}

// Allowed-users gate. `pattern` is a regular expression (string or RegExp)
// matched case-insensitively against the signed-in email. Unset means allow
// all; an invalid pattern throws so the hub fails closed at startup.
export function compileAllowedUsers(pattern) {
  if (pattern === undefined || pattern === null || pattern === "") return undefined;
  if (pattern instanceof RegExp) return pattern;
  try {
    return new RegExp(String(pattern), "i");
  } catch (error) {
    throw new Error(`invalid allowed-users pattern: ${error.message}`);
  }
}

export class AuthService {
  constructor({ accounts, google, sessionSecret, allowedUsers, now = Date.now, pendingTtlMs = 10 * 60_000, sessionTtlMs = 7 * 24 * 3_600_000, stateTtlMs = 10 * 60_000 }) {
    this.accounts = accounts;
    this.google = google;
    this.sessionSecret = sessionSecret;
    this.allowedUsers = compileAllowedUsers(allowedUsers);
    this.now = now;
    this.pendingTtlMs = pendingTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.stateTtlMs = stateTtlMs;
    this.flows = new Map();
    this.deviceFlows = new Map();
  }

  startLogin({ returnTo = "/" } = {}) {
    const state = newNonce();
    const { verifier, challenge } = pkcePair();
    this.flows.set(state, { verifier, returnTo, expiresAt: this.now() + this.stateTtlMs });
    const url = this.google.createAuthUrl({ state, codeChallenge: challenge });
    return { url, state };
  }

  completeCallback({ code, state }) {
    const flow = this.flows.get(state);
    if (!flow || flow.expiresAt < this.now()) throw new Error("invalid or expired OAuth state");
    this.flows.delete(state);
    return { flow, code };
  }

  async handleCallback({ code, state }) {
    const { flow } = this.completeCallback({ code, state });
    const user = await this.google.authenticate({ code, codeVerifier: flow.verifier });
    if (!this.isEmailAllowed(user.email)) {
      const error = new Error(`Access denied for ${user.email}`);
      error.code = "access_denied";
      throw error;
    }
    const account = this.accounts.upsertGoogleAccount(user);
    if (this.accounts.mfaRequired(account.id)) {
      const pendingToken = issueToken({
        payload: { kind: "pending", accountId: account.id },
        secret: this.sessionSecret,
        ttlMs: this.pendingTtlMs,
        now: this.now(),
      });
      return { accountId: account.id, mfaRequired: true, returnTo: flow.returnTo, pendingToken, sessionToken: null };
    }
    const sessionToken = this.#issueSession(account.id);
    return { accountId: account.id, mfaRequired: false, returnTo: flow.returnTo, pendingToken: null, sessionToken };
  }

  enrollMfa(accountId) {
    return this.accounts.enrollMfa(accountId);
  }

  activateMfa(accountId, code) {
    return this.accounts.activateMfa(accountId, code);
  }

  completeMfa({ pendingToken, code, recoveryCode }) {
    const pending = verifyToken(pendingToken, this.sessionSecret, { now: this.now() });
    if (!pending || pending.kind !== "pending") throw new Error("invalid or expired pending token");
    const accountId = pending.accountId;
    let ok = false;
    if (recoveryCode) ok = this.accounts.useRecoveryCode(accountId, recoveryCode);
    else if (code) ok = this.accounts.verifyMfa(accountId, code);
    if (!ok) throw new Error("invalid MFA code");
    return { accountId, sessionToken: this.#issueSession(accountId) };
  }

  verifySession(token) {
    const payload = verifyToken(token, this.sessionSecret, { now: this.now() });
    if (!payload || payload.kind !== "session") return null;
    return payload;
  }

  isEmailAllowed(email) {
    if (!this.allowedUsers) return true;
    this.allowedUsers.lastIndex = 0;
    return this.allowedUsers.test(String(email ?? ""));
  }

  // -- device authorization (for in-pi onboarding) ----------------------

  startDeviceFlow({ ttlMs = 10 * 60_000, interval = 3 } = {}) {
    const deviceCode = randomBytes(24).toString("base64url");
    const userCode = generateUserCode();
    this.deviceFlows.set(deviceCode, { userCode, status: "pending", expiresAt: this.now() + ttlMs, sessionToken: null, interval });
    return { deviceCode, userCode, expiresIn: Math.floor(ttlMs / 1000), interval };
  }

  approveDeviceFlow(userCode, accountId) {
    const normalized = String(userCode).trim().toUpperCase();
    for (const flow of this.deviceFlows.values()) {
      if (flow.userCode !== normalized) continue;
      if (flow.status !== "pending" || flow.expiresAt < this.now()) return { ok: false, reason: "expired" };
      flow.status = "approved";
      flow.sessionToken = this.#issueSession(accountId);
      return { ok: true };
    }
    return { ok: false, reason: "unknown_code" };
  }

  pollDeviceFlow(deviceCode) {
    const flow = this.deviceFlows.get(deviceCode);
    if (!flow) return { status: "invalid" };
    if (flow.expiresAt < this.now()) {
      this.deviceFlows.delete(deviceCode);
      return { status: "expired" };
    }
    if (flow.status === "approved") {
      const sessionToken = flow.sessionToken;
      this.deviceFlows.delete(deviceCode);
      return { status: "approved", sessionToken };
    }
    return { status: flow.status === "pending" ? "pending" : "expired" };
  }

  #issueSession(accountId) {
    return issueToken({
      payload: { kind: "session", accountId, mfa: true },
      secret: this.sessionSecret,
      ttlMs: this.sessionTtlMs,
      now: this.now(),
    });
  }
}
