import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearHostState, ensureHostKeys, loadHostState, saveHostState } from "../../src/host/onboarding.mjs";

describe("host onboarding state", () => {
  it("generates and persists host keys once", () => {
    const dir = mkdtempSync(join(tmpdir(), "pinet-state-"));
    try {
      const first = ensureHostKeys(dir);
      expect(first.identity.publicKey).toBeTruthy();
      expect(first.encryption.publicKey).toBeTruthy();
      const second = ensureHostKeys(dir);
      expect(second.identity.publicKey).toBe(first.identity.publicKey);
      expect(loadHostState(dir).identity.publicKey).toBe(first.identity.publicKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges patches and clears", () => {
    const dir = mkdtempSync(join(tmpdir(), "pinet-state-"));
    try {
      saveHostState(dir, { hostId: "host_x" });
      saveHostState(dir, { fingerprint: "abc" });
      expect(loadHostState(dir)).toMatchObject({ hostId: "host_x", fingerprint: "abc" });
      clearHostState(dir);
      expect(loadHostState(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
