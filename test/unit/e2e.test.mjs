import { describe, expect, it } from "vitest";
import {
  commandAad,
  frameAad,
  generateGroupKey,
  open,
  openJson,
  seal,
  sealJson,
  unwrapGroupKey,
  wrapGroupKey,
} from "../../src/crypto/e2e.mjs";
import { generateX25519 } from "../../src/crypto/keys.mjs";

describe("aead seal/open", () => {
  it("round-trips json with bound aad", () => {
    const key = generateGroupKey();
    const aad = frameAad({ sessionId: "s1", epoch: 1, seq: 7, type: "session.entries" });
    const box = sealJson(key, { entries: [{ id: "e1" }] }, aad);
    expect(openJson(key, box, aad)).toEqual({ entries: [{ id: "e1" }] });
  });

  it("rejects tampered ciphertext or tag", () => {
    const key = generateGroupKey();
    const aad = frameAad({ sessionId: "s1", epoch: 1, seq: 7, type: "session.entries" });
    const box = seal(key, "secret", aad);
    expect(() => open(key, { ...box, ct: Buffer.from("nope").toString("base64") }, aad)).toThrow();
    expect(() => open(key, { ...box, tag: Buffer.alloc(16).toString("base64") }, aad)).toThrow();
  });

  it("is unreadable without the group key", () => {
    const key = generateGroupKey();
    const other = generateGroupKey();
    const aad = frameAad({ sessionId: "s1", epoch: 1, seq: 1, type: "session.entries" });
    const box = seal(key, "top secret", aad);
    expect(() => open(other, box, aad)).toThrow();
  });

  it("rejects mismatched aad (metadata tampering)", () => {
    const key = generateGroupKey();
    const box = seal(key, "secret", frameAad({ sessionId: "s1", epoch: 1, seq: 7, type: "session.entries" }));
    expect(() => open(key, box, frameAad({ sessionId: "s1", epoch: 1, seq: 8, type: "session.entries" }))).toThrow();
    expect(() => open(key, box, frameAad({ sessionId: "s2", epoch: 1, seq: 7, type: "session.entries" }))).toThrow();
  });
});

describe("group key wrapping", () => {
  it("wraps and unwraps for a controller", () => {
    const host = generateX25519();
    const controller = generateX25519();
    const groupKey = generateGroupKey();
    const aadParts = { sessionId: "s1", epoch: 3, deviceId: "d1" };
    const wrapped = wrapGroupKey({ recipientEncPub: controller.publicKey, groupKey, aadParts });
    const unwrapped = unwrapGroupKey({ recipientEncPriv: controller.privateKey, hostEphPub: wrapped.hostEphPub, wrapped, aadParts });
    expect(unwrapped.equals(groupKey)).toBe(true);
  });

  it("fails for the wrong recipient or bound metadata", () => {
    const controller = generateX25519();
    const attacker = generateX25519();
    const groupKey = generateGroupKey();
    const aadParts = { sessionId: "s1", epoch: 3, deviceId: "d1" };
    const wrapped = wrapGroupKey({ recipientEncPub: controller.publicKey, groupKey, aadParts });
    expect(() =>
      unwrapGroupKey({ recipientEncPriv: attacker.privateKey, hostEphPub: wrapped.hostEphPub, wrapped, aadParts }),
    ).toThrow();
    expect(() =>
      unwrapGroupKey({
        recipientEncPriv: controller.privateKey,
        hostEphPub: wrapped.hostEphPub,
        wrapped,
        aadParts: { ...aadParts, epoch: 4 },
      }),
    ).toThrow();
  });
});

describe("aad builders", () => {
  it("are order-independent for the same fields", () => {
    const a = commandAad({ sessionId: "s", commandId: "c", epoch: 1, op: "prompt", deviceId: "d" });
    const b = commandAad({ deviceId: "d", op: "prompt", epoch: 1, commandId: "c", sessionId: "s" });
    expect(a.equals(b)).toBe(true);
  });
});
