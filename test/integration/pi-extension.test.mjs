import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PinetController } from "../../src/controller/client.mjs";
import { createCoordinator } from "../../src/coordinator/server.mjs";
import { enrollDevice, waitFor } from "../helpers/harness.mjs";

const hasPi = spawnSync("which", ["pi"], { stdio: "ignore" }).status === 0;
const suite = hasPi ? describe : describe.skip;

async function waitUntil(check, timeoutMs = 25_000) {
  const start = Date.now();
  for (;;) {
    if (check()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

suite("pi extension (real process)", () => {
  let coord;
  let piProcess;
  let tmp;

  afterAll(async () => {
    piProcess?.kill("SIGKILL");
    await coord?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "enrolls, registers its session, and serves it to an authenticated controller",
    async () => {
      coord = await createCoordinator({
        config: { port: 0, host: "127.0.0.1", sessionSecret: "pi-test-secret", serverId: "srv_pi_ext" },
      });
      const account = coord.accounts.upsertGoogleAccount({ sub: "pi-ext", email: "pi-ext@example.com", name: "pi" });
      const { code } = coord.accounts.createHostEnrollment(account.id, { ttlMs: 120_000 });

      tmp = mkdtempSync(join(tmpdir(), "pinet-pi-"));
      piProcess = spawn(
        "pi",
        ["--mode", "rpc", "--no-extensions", "-e", "/root/pinet/extension/index.ts", "--session-dir", join(tmp, "sessions")],
        {
          env: {
            ...process.env,
            PINET_HUB: coord.wsUrl,
            PINET_HTTP: coord.httpUrl,
            PINET_ENROLL_CODE: code,
            PINET_DIR: join(tmp, "state"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let log = "";
      piProcess.stdout.on("data", (chunk) => (log += chunk));
      piProcess.stderr.on("data", (chunk) => (log += chunk));

      const enrolled = await waitUntil(() => coord.accounts.listDevices(account.id, "host").length === 1);
      expect(enrolled, `host did not enroll; pi log:\n${log}`).toBe(true);

      const sessionReady = await waitUntil(() => coord.registry.catalog(account.id).length >= 1);
      expect(sessionReady, `no session registered; pi log:\n${log}`).toBe(true);

      const controllerEnrollment = enrollDevice(coord.accounts, account.id, "controller", "test-controller");
      const controller = new PinetController({
        url: coord.wsUrl,
        deviceId: controllerEnrollment.device.id,
        identity: controllerEnrollment.identity,
        encryption: controllerEnrollment.encryption,
      });
      await controller.connect();
      const catalog = await controller.list();
      expect(catalog).toHaveLength(1);

      const sessionId = catalog[0].sessionId;
      const snapshotPromise = waitFor(controller, "snapshot", () => true, 20_000);
      await controller.attach(sessionId, "control");
      const snapshot = await snapshotPromise;
      expect(snapshot.sessionId).toBe(sessionId);
      expect(Array.isArray(snapshot.entries)).toBe(true);

      // Exercise the real command path (safe op, no model call).
      const ack = await controller.command(sessionId, "rename", { name: "renamed-by-test" });
      expect(ack).toMatchObject({ accepted: true, mode: "immediate" });

      controller.close();
    },
    60_000,
  );
});
