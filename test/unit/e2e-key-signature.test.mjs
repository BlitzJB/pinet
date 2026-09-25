import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/common/canonical.mjs";
import { generateEd25519, sign, verify } from "../../src/crypto/keys.mjs";

const wrapped = { hostEphPub: "eph", n: "iv", ct: "cipher", tag: "tag" };
const payloadFor = (w) => canonicalJson({ type: "e2e.key", sessionId: "s1", attachmentId: "a1", epoch: 1, wrapped: w, deviceId: "host1" });

describe("host-signed key wraps", () => {
  it("verifies a genuine signature and rejects tampering", () => {
    const host = generateEd25519();
    const signature = sign(payloadFor(wrapped), host.privateKey);
    expect(verify(payloadFor(wrapped), signature, host.publicKey)).toBe(true);
    expect(verify(payloadFor({ ...wrapped, ct: "evil" }), signature, host.publicKey)).toBe(false);
    expect(verify(payloadFor({ ...wrapped, epoch: 2 }), signature, host.publicKey)).toBe(false);
  });
});
