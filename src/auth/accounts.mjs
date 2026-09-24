// Account, MFA, device and host-enrollment store.
//
// Optionally file-backed (`persistPath`) so a service restart does not lose
// enrollments or MFA replay state. Writes are atomic (temp + rename) and the
// file is created 0600; the store contains MFA secrets and recovery hashes, so
// the directory must be private (0700).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fingerprint } from "../crypto/keys.mjs";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, verifyTotp } from "../crypto/totp.mjs";
import { newId } from "../common/ids.mjs";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function enrollmentCode() {
  const bytes = randomBytes(8);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

export class AccountStore {
  constructor({ now = Date.now, persistPath } = {}) {
    this.now = now;
    this.persistPath = persistPath;
    this.accounts = new Map();
    this.devices = new Map();
    this.enrollments = new Map();
    if (persistPath) this.#load();
  }

  #load() {
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.persistPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const account of raw.accounts ?? []) this.accounts.set(account.id, account);
    for (const device of raw.devices ?? []) this.devices.set(device.id, device);
    for (const entry of raw.enrollments ?? []) {
      const { code, ...rest } = entry;
      this.enrollments.set(code, rest);
    }
  }

  #save() {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({
      version: 1,
      savedAt: this.now(),
      accounts: [...this.accounts.values()],
      devices: [...this.devices.values()],
      enrollments: [...this.enrollments.entries()].map(([code, entry]) => ({ code, ...entry })),
    });
    const temporary = `${this.persistPath}.tmp`;
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, this.persistPath);
  }

  // -- accounts -------------------------------------------------------------

  upsertGoogleAccount({ sub, email, name }) {
    for (const account of this.accounts.values()) {
      if (account.sub === sub || account.email === email) {
        account.name = name ?? account.name;
        account.email = email;
        account.sub = sub;
        this.#save();
        return account;
      }
    }
    const account = {
      id: newId("acct"),
      sub,
      email,
      name: name ?? email,
      createdAt: this.now(),
      mfa: { enrolled: false, secret: null, lastCounter: -1, recovery: [] },
    };
    this.accounts.set(account.id, account);
    this.#save();
    return account;
  }

  getAccount(id) {
    return this.accounts.get(id);
  }

  getAccountByEmail(email) {
    return [...this.accounts.values()].find((account) => account.email === email);
  }

  // -- MFA ------------------------------------------------------------------

  enrollMfa(accountId) {
    const account = this.#require(accountId);
    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes();
    account.mfa.secret = secret;
    account.mfa.enrolled = false;
    account.mfa.lastCounter = -1;
    account.mfa.recovery = recoveryCodes.map((code) => ({ hash: hashRecoveryCode(code), used: false }));
    this.#save();
    return { secret, uri: otpauthUri({ secret, account: account.email }), recoveryCodes };
  }

  activateMfa(accountId, code) {
    const account = this.#require(accountId);
    if (!account.mfa.secret) return false;
    const result = verifyTotp(account.mfa.secret, code, { lastCounter: -1 });
    if (!result.ok) return false;
    account.mfa.enrolled = true;
    // Activation proves possession; it deliberately does not consume the
    // counter, so the first real login may reuse the same time step.
    this.#save();
    return true;
  }

  verifyMfa(accountId, code) {
    const account = this.#require(accountId);
    if (!account.mfa.enrolled || !account.mfa.secret) return false;
    const result = verifyTotp(account.mfa.secret, code, { lastCounter: account.mfa.lastCounter });
    if (!result.ok) return false;
    account.mfa.lastCounter = result.counter;
    this.#save();
    return true;
  }

  useRecoveryCode(accountId, code) {
    const account = this.#require(accountId);
    if (!account.mfa.enrolled) return false;
    const hash = hashRecoveryCode(code);
    const entry = account.mfa.recovery.find((candidate) => !candidate.used && candidate.hash === hash);
    if (!entry) return false;
    entry.used = true;
    this.#save();
    return true;
  }

  mfaRequired(accountId) {
    return this.#require(accountId).mfa.enrolled === true;
  }

  // -- devices --------------------------------------------------------------

  registerDevice({ accountId, kind, name, identityPub, encPub }) {
    this.#require(accountId);
    if (kind !== "controller" && kind !== "host") throw new Error(`invalid device kind: ${kind}`);
    const device = {
      id: newId(kind === "host" ? "host" : "dev"),
      accountId,
      kind,
      name: name ?? kind,
      identityPub,
      encPub,
      fingerprint: fingerprint(identityPub),
      createdAt: this.now(),
      revoked: false,
    };
    this.devices.set(device.id, device);
    this.#save();
    return device;
  }

  getDevice(id) {
    return this.devices.get(id);
  }

  listDevices(accountId, kind) {
    return [...this.devices.values()].filter(
      (device) => device.accountId === accountId && (!kind || device.kind === kind),
    );
  }

  revokeDevice(id) {
    const device = this.devices.get(id);
    if (!device) return false;
    device.revoked = true;
    this.#save();
    return true;
  }

  // -- host enrollment ------------------------------------------------------

  createHostEnrollment(accountId, { ttlMs = 10 * 60_000 } = {}) {
    this.#require(accountId);
    const code = enrollmentCode();
    this.enrollments.set(code, { accountId, expiresAt: this.now() + ttlMs, used: false });
    this.#save();
    return { code, expiresAt: this.now() + ttlMs };
  }

  consumeHostEnrollment(code) {
    const entry = this.enrollments.get(code);
    if (!entry || entry.used || entry.expiresAt < this.now()) return null;
    entry.used = true;
    this.#save();
    return { accountId: entry.accountId };
  }

  #require(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    return account;
  }
}
