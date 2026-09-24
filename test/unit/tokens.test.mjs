import { describe, expect, it } from "vitest";
import { issueToken, verifyToken } from "../../src/auth/tokens.mjs";

const SECRET = "test-secret";

describe("signed tokens", () => {
  it("issues and verifies a payload", () => {
    const token = issueToken({ payload: { kind: "session", accountId: "a1" }, secret: SECRET, ttlMs: 1000, now: 1000 });
    expect(verifyToken(token, SECRET, { now: 1500 })).toMatchObject({ kind: "session", accountId: "a1" });
  });

  it("rejects an expired token", () => {
    const token = issueToken({ payload: { kind: "session", accountId: "a1" }, secret: SECRET, ttlMs: 1000, now: 1000 });
    expect(verifyToken(token, SECRET, { now: 2500 })).toBeNull();
  });

  it("rejects a tampered payload or wrong secret", () => {
    const token = issueToken({ payload: { kind: "session", accountId: "a1" }, secret: SECRET, ttlMs: 1000, now: 1000 });
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ kind: "session", accountId: "evil", iat: 1000, exp: 10_000 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, SECRET, { now: 1500 })).toBeNull();
    expect(verifyToken(token, "other-secret", { now: 1500 })).toBeNull();
    expect(verifyToken("garbage", SECRET)).toBeNull();
  });
});
