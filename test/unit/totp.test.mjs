import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, hotp, otpauthUri, totp, verifyTotp } from "../../src/crypto/totp.mjs";

// RFC 6238 Appendix B, SHA-1, 8 digits.
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_VECTORS = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("base32", () => {
  it("round-trips bytes", () => {
    const input = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    expect(base32Decode(base32Encode(input)).equals(input)).toBe(true);
  });

  it("rejects invalid characters", () => {
    expect(() => base32Decode("1890")).toThrow();
  });
});

describe("hotp", () => {
  it("matches RFC 4226 test vectors", () => {
    const secret = Buffer.from("12345678901234567890", "ascii");
    expect(hotp(secret, 0, { digits: 6 })).toBe("755224");
    expect(hotp(secret, 1, { digits: 6 })).toBe("287082");
    expect(hotp(secret, 2, { digits: 6 })).toBe("359152");
    expect(hotp(secret, 3, { digits: 6 })).toBe("969429");
    expect(hotp(secret, 4, { digits: 6 })).toBe("338314");
  });
});

describe("totp", () => {
  it.each(RFC_VECTORS)("matches RFC 6238 at t=%i", (seconds, expected) => {
    expect(totp(RFC_SECRET, { time: seconds * 1000, digits: 8 })).toBe(expected);
    expect(totp(RFC_SECRET, { time: seconds * 1000, digits: 6 })).toBe(expected.slice(-6));
  });

  it("generates a 20-byte base32 secret by default", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/u);
    expect(base32Decode(secret).length).toBe(20);
  });

  it("builds a valid otpauth URI", () => {
    const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "user@example.com" });
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Pinet");
  });
});

describe("verifyTotp", () => {
  const secret = generateTotpSecret();
  const at = 1_700_000_000_000;

  it("accepts the current code", () => {
    const code = totp(secret, { time: at });
    expect(verifyTotp(secret, code, { time: at })).toMatchObject({ ok: true });
  });

  it("accepts adjacent steps within the window", () => {
    const code = totp(secret, { time: at });
    expect(verifyTotp(secret, code, { time: at + 30_000 })).toMatchObject({ ok: true });
    expect(verifyTotp(secret, code, { time: at - 30_000 })).toMatchObject({ ok: true });
  });

  it("rejects codes outside the window", () => {
    const code = totp(secret, { time: at });
    expect(verifyTotp(secret, code, { time: at + 120_000 })).toMatchObject({ ok: false });
  });

  it("rejects malformed codes", () => {
    expect(verifyTotp(secret, "abc", { time: at }).ok).toBe(false);
    expect(verifyTotp(secret, "12345", { time: at }).ok).toBe(false);
  });

  it("prevents replay with lastCounter", () => {
    const code = totp(secret, { time: at });
    const first = verifyTotp(secret, code, { time: at });
    expect(first.ok).toBe(true);
    const replay = verifyTotp(secret, code, { time: at, lastCounter: first.counter });
    expect(replay.ok).toBe(false);
  });
});

describe("recovery codes", () => {
  it("generates unique hashable codes", () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/u);
    expect(hashRecoveryCode(codes[0])).toBe(hashRecoveryCode(codes[0].toLowerCase()));
  });
});
