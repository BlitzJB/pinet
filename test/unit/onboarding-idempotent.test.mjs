import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateEd25519, generateX25519 } from "../../src/crypto/keys.mjs";
import { loadHostState, onboardHost, saveHostState } from "../../src/host/onboarding.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinet-onboard-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("idempotent onboarding", () => {
  it("reuses an existing enrollment instead of registering a duplicate device", async () => {
    const identity = generateEd25519();
    const encryption = generateX25519();
    saveHostState(dir, { hostId: "host_existing", deviceId: "host_existing", identity, encryption, fingerprint: "abc" });

    let networkCalls = 0;
    const result = await onboardHost({
      httpUrl: "http://127.0.0.1:1",
      dir,
      name: "machine",
      fetchImpl: async () => {
        networkCalls += 1;
        throw new Error("network must not be called for an existing enrollment");
      },
    });

    expect(result.hostId).toBe("host_existing");
    expect(networkCalls).toBe(0);
    expect(loadHostState(dir).hostId).toBe("host_existing");
  });
});
