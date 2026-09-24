import { describe, expect, it } from "vitest";
import { ecdh, fingerprint, generateEd25519, generateX25519, sign, verify } from "../../src/crypto/keys.mjs";

describe("ed25519 identity keys", () => {
  it("signs and verifies", () => {
    const { publicKey, privateKey } = generateEd25519();
    const sig = sign("hello", privateKey);
    expect(verify("hello", sig, publicKey)).toBe(true);
  });

  it("fails on tampered message or signature", () => {
    const { publicKey, privateKey } = generateEd25519();
    const sig = sign("hello", privateKey);
    expect(verify("hell0", sig, publicKey)).toBe(false);
    const other = generateEd25519();
    expect(verify("hello", sig, other.publicKey)).toBe(false);
  });

  it("produces a stable fingerprint", () => {
    const { publicKey } = generateEd25519();
    expect(fingerprint(publicKey)).toBe(fingerprint(publicKey));
    expect(fingerprint(publicKey)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("x25519 key agreement", () => {
  it("derives the same shared secret in both directions", () => {
    const a = generateX25519();
    const b = generateX25519();
    expect(ecdh(a.privateKey, b.publicKey).equals(ecdh(b.privateKey, a.publicKey))).toBe(true);
  });

  it("does not derive the same secret for a different peer", () => {
    const a = generateX25519();
    const b = generateX25519();
    const c = generateX25519();
    expect(ecdh(a.privateKey, b.publicKey).equals(ecdh(a.privateKey, c.publicKey))).toBe(false);
  });
});
