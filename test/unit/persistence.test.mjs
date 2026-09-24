import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountStore } from "../../src/auth/accounts.mjs";
import { generateEd25519, generateX25519 } from "../../src/crypto/keys.mjs";
import { totp } from "../../src/crypto/totp.mjs";

let dir;
let path;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinet-persist-"));
  path = join(dir, "store.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("persistent account store", () => {
  it("survives a restart (account, MFA, devices, enrollment codes)", () => {
    const store = new AccountStore({ persistPath: path });
    const account = store.upsertGoogleAccount({ sub: "g1", email: "a@x.com", name: "A" });
    const { secret } = store.enrollMfa(account.id);
    store.activateMfa(account.id, totp(secret));
    const identity = generateEd25519();
    const encryption = generateX25519();
    const device = store.registerDevice({ accountId: account.id, kind: "host", name: "h", identityPub: identity.publicKey, encPub: encryption.publicKey });
    const { code } = store.createHostEnrollment(account.id);

    const reloaded = new AccountStore({ persistPath: path });
    expect(reloaded.getAccountByEmail("a@x.com")).toMatchObject({ id: account.id });
    expect(reloaded.mfaRequired(account.id)).toBe(true);
    expect(reloaded.getDevice(device.id)).toMatchObject({ kind: "host", revoked: false });
    expect(reloaded.consumeHostEnrollment(code)).toMatchObject({ accountId: account.id });
  });

  it("persists TOTP replay state across restarts", () => {
    const store = new AccountStore({ persistPath: path });
    const account = store.upsertGoogleAccount({ sub: "g2", email: "b@x.com" });
    const { secret } = store.enrollMfa(account.id);
    store.activateMfa(account.id, totp(secret));
    const code = totp(secret);
    expect(store.verifyMfa(account.id, code)).toBe(true);

    const reloaded = new AccountStore({ persistPath: path });
    expect(reloaded.verifyMfa(account.id, code)).toBe(false); // replay rejected after restart
  });

  it("does not persist when no path is configured", () => {
    const store = new AccountStore();
    const account = store.upsertGoogleAccount({ sub: "g3", email: "c@x.com" });
    expect(store.getAccount(account.id)).toBeTruthy();
    expect(new AccountStore().accounts.size).toBe(0);
  });
});
