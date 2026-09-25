import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCoordinator } from "../../src/coordinator/server.mjs";

let coord;

beforeAll(async () => {
  coord = await createCoordinator({
    config: { port: 0, host: "127.0.0.1", sessionSecret: "rate-secret", serverId: "srv_rate" },
  });
});

afterAll(async () => {
  await coord.close();
});

describe("rate limiting", () => {
  it("returns 429 after too many sensitive requests from one client", async () => {
    let sawTooMany = false;
    for (let i = 0; i < 80; i += 1) {
      const response = await fetch(`${coord.httpUrl}/auth/device/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: `nope-${i}` }),
      });
      if (response.status === 429) {
        sawTooMany = true;
        break;
      }
    }
    expect(sawTooMany).toBe(true);
  });
});
