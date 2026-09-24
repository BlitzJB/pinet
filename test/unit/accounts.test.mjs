import { describe, expect, it } from "vitest";
import { AccountStore } from "../../src/auth/accounts.mjs";
import { generateEd25519, generateX25519 } from "../../src/crypto/keys.mjs";
import { totp } from "../../src/crypto/totp.mjs";

function store(now = 1000) {
  let clock = now;
  const s = new AccountStore({ now: () => clock });
  return { s, tick: (ms) => (clock += ms) };
}

const identity = generateEd25519();
const encryption = generateX25519();

describe("accounts", () => {
  it("creates one account per google subject and reuses it", () => {
    const { s } = store();
    const a = s.upsertGoogleAccount({ sub: "g1", email: "a@x.com", name: "A" });
    const b = s.upsertGoogleAccount({ sub: "g1", email: "a@x.com", name: "A2" });
    expect(a.id).toBe(b.id);
    expect(b.name).toBe("A2");
  });
});

describe("mfa", () => {
  it("enrolls, activates and verifies, preventing replay", () => {
    const { s } = store();
    const account = s.upsertGoogleAccount({ sub: "g1", email: "a@x.com" });
    expect(s.mfaRequired(account.id)).toBe(false);
    const { secret, uri, recoveryCodes } = s.enrollMfa(account.id);
    expect(uri).toContain("otpauth://totp/");
    expect(recoveryCodes).toHaveLength(10);
    expect(s.activateMfa(account.id, "000000")).toBe(false);
    expect(s.activateMfa(account.id, totp(secret))).toBe(true);
    expect(s.mfaRequired(account.id)).toBe(true);

    const code = totp(secret);
    const counter = Math.floor(Date.now() / 1000 / 30);
    // consume the current counter, then replay must fail
    expect(s.verifyMfa(account.id, code)).toBe(true);
    expect(s.verifyMfa(account.id, code)).toBe(false);
    expect(counter).toBeGreaterThan(0);
  });

  it("consumes recovery codes once", () => {
    const { s } = store();
    const account = s.upsertGoogleAccount({ sub: "g2", email: "b@x.com" });
    const { secret, recoveryCodes } = s.enrollMfa(account.id);
    s.activateMfa(account.id, totp(secret));
    expect(s.useRecoveryCode(account.id, recoveryCodes[0])).toBe(true);
    expect(s.useRecoveryCode(account.id, recoveryCodes[0])).toBe(false);
    expect(s.useRecoveryCode(account.id, "AAAAA-BBBBB")).toBe(false);
  });
});

describe("devices", () => {
  it("registers, lists and revokes", () => {
    const { s } = store();
    const account = s.upsertGoogleAccount({ sub: "g3", email: "c@x.com" });
    const device = s.registerDevice({
      accountId: account.id,
      kind: "controller",
      name: "phone",
      identityPub: identity.publicKey,
      encPub: encryption.publicKey,
    });
    expect(device.accountId).toBe(account.id);
    expect(device.revoked).toBe(false);
    expect(s.listDevices(account.id)).toHaveLength(1);
    expect(s.revokeDevice(device.id)).toBe(true);
    expect(s.getDevice(device.id).revoked).toBe(true);
  });
});

describe("host enrollment", () => {
  it("is single-use and expiring", () => {
    const { s, tick } = store();
    const account = s.upsertGoogleAccount({ sub: "g4", email: "d@x.com" });
    const { code } = s.createHostEnrollment(account.id, { ttlMs: 1000 });
    expect(s.consumeHostEnrollment(code)).toMatchObject({ accountId: account.id });
    expect(s.consumeHostEnrollment(code)).toBeNull();
    const second = s.createHostEnrollment(account.id, { ttlMs: 100 });
    tick(200);
    expect(s.consumeHostEnrollment(second.code)).toBeNull();
  });
});
