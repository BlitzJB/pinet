import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import portalExtension from "../../extension/portal.ts";
import { enrollDevice, makeAccount, startCoordinator } from "../helpers/harness.mjs";
import { HostBridge } from "../../src/host/bridge.mjs";

const SESSION = "s_portal";

async function waitUntil(check, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    if (check()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function fakePi() {
  const handlers = {};
  const commands = {};
  const renderers = {};
  const appended = [];
  return {
    handlers,
    commands,
    renderers,
    appended,
    on(type, handler) {
      (handlers[type] ??= []).push(handler);
    },
    registerCommand(name, options) {
      commands[name] = options;
    },
    registerEntryRenderer(type, renderer) {
      renderers[type] = renderer;
    },
    appendEntry(type, data) {
      appended.push({ type, data });
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

const ctx = { ui: { setStatus() {}, notify() {} } };

let coord;
let account;
let host;
let dir;

beforeEach(async () => {
  coord = await startCoordinator();
  account = makeAccount(coord.accounts, "portal@example.com");
  dir = mkdtempSync(join(tmpdir(), "pinet-portal-"));

  const enrolledHost = enrollDevice(coord.accounts, account.id, "host", "remote-host");
  host = new HostBridge({
    url: coord.url,
    deviceId: enrolledHost.device.id,
    identity: enrolledHost.identity,
    encryption: enrolledHost.encryption,
    hostName: "remote-host",
  });
  host.setSnapshotProvider(() => ({
    entries: [{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "remote hello" } }],
    status: { phase: "idle" },
    meta: { name: "remote" },
  }));
  await host.connect();
  host.openSession({ sessionId: SESSION, meta: { name: "remote" } });
});

afterEach(async () => {
  host?.close();
  await coord.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeControllerState() {
  const device = enrollDevice(coord.accounts, account.id, "controller", "portal-pi");
  writeFileSync(join(dir, "controller.json"), JSON.stringify({ deviceId: device.device.id, identity: device.identity, encryption: device.encryption }));
}

describe("pi portal extension", () => {
  it("attaches, renders remote blocks, and forwards typed input", async () => {
    writeControllerState();
    process.env.PINET_DIR = dir;
    process.env.PINET_HUB = coord.url;
    process.env.PINET_HTTP = coord.httpUrl;
    try {
      const pi = fakePi();
      portalExtension(pi);

      expect(pi.commands.portal).toBeTruthy();
      await pi.commands.portal.handler(`attach ${SESSION}`, ctx);

      // The remote snapshot should render locally.
      const rendered = await waitUntil(() => pi.appended.some((e) => e.data?.kind === "user" && e.data.body === "remote hello"));
      expect(rendered, JSON.stringify(pi.appended)).toBe(true);

      // Typed input is intercepted and forwarded to the remote host.
      const received = [];
      host.onCommand(async ({ op, args }) => {
        received.push({ op, args });
        return { accepted: true, mode: "steer" };
      });
      const result = await pi.handlers.input[0]({ text: "hello remote", source: "interactive" }, ctx);
      expect(result).toEqual({ action: "handled" });
      expect(received[0]).toMatchObject({ op: "prompt", args: { text: "hello remote" } });

      // Remote entries published later stream into the local transcript.
      host.publishEntries([{ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "remote reply" }] } }]);
      const streamed = await waitUntil(() => pi.appended.some((e) => e.data?.kind === "assistant" && e.data.body === "remote reply"));
      expect(streamed, JSON.stringify(pi.appended)).toBe(true);

      await pi.commands.portal.handler("detach", ctx);
      // After detach, input is no longer intercepted.
      const after = await pi.handlers.input[0]({ text: "local now", source: "interactive" }, ctx);
      expect(after).toEqual({ action: "continue" });
    } finally {
      delete process.env.PINET_DIR;
      delete process.env.PINET_HUB;
      delete process.env.PINET_HTTP;
    }
  });
});
