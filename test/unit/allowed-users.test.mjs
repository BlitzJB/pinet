import { describe, expect, it } from "vitest";
import { compileAllowedUsers } from "../../src/auth/service.mjs";

describe("compileAllowedUsers", () => {
  it("is undefined when unset (allow all)", () => {
    expect(compileAllowedUsers(undefined)).toBeUndefined();
    expect(compileAllowedUsers("")).toBeUndefined();
  });

  it("matches case-insensitively", () => {
    const pattern = compileAllowedUsers("^Allowed@Example\\.com$");
    expect(pattern.test("allowed@example.com")).toBe(true);
    expect(pattern.test("nobody@example.com")).toBe(false);
  });

  it("supports domain and alternation patterns", () => {
    expect(compileAllowedUsers("@example\\.com$").test("anyone@example.com")).toBe(true);
    expect(compileAllowedUsers("^(alice|bob)@example\\.com$").test("bob@example.com")).toBe(true);
    expect(compileAllowedUsers("^(alice|bob)@example\\.com$").test("carol@example.com")).toBe(false);
  });

  it("throws on an invalid pattern (fails closed)", () => {
    expect(() => compileAllowedUsers("[")).toThrow(/invalid allowed-users pattern/);
  });
});
