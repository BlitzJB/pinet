import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const hasPi = spawnSync("which", ["pi"], { stdio: "ignore" }).status === 0;
const suite = hasPi ? describe : describe.skip;

suite("portal extension in real pi", () => {
  it(
    "loads and registers the /portal command",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pinet-portal-load-"));
      const pi = spawn(
        "pi",
        ["--mode", "rpc", "--no-extensions", "-e", "/root/pinet/extension/portal.ts", "--session-dir", join(tmp, "sessions")],
        { env: { ...process.env, PINET_DIR: tmp }, stdio: ["pipe", "pipe", "pipe"] },
      );
      let log = "";
      pi.stdout.on("data", (chunk) => (log += chunk));
      pi.stderr.on("data", (chunk) => (log += chunk));

      try {
        const response = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout waiting for get_commands; log:\n${log}`)), 30_000);
          const inspect = () => {
            for (const line of log.split("\n")) {
              if (!line.trim()) continue;
              try {
                const message = JSON.parse(line);
                if (message.type === "response" && message.command === "get_commands") {
                  clearTimeout(timer);
                  resolve(message);
                }
              } catch {
                /* partial line */
              }
            }
          };
          pi.stdout.on("data", inspect);
          setTimeout(() => pi.stdin.write(`${JSON.stringify({ id: "c1", type: "get_commands" })}\n`), 2500);
        });
        const names = response.data.commands.map((command) => command.name);
        expect(names).toContain("portal");
      } finally {
        pi.kill("SIGKILL");
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
