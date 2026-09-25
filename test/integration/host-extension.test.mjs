import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hostExtension from "../../extension/index.ts";
import { PinetController } from "../../src/controller/client.mjs";
import { enrollDevice, makeAccount, startCoordinator, waitFor } from "../helpers/harness.mjs";

const SESSION = "s_hostext";

// pi hands a *fresh* context object to each handler; reproduce that here.
function makeCtx(store) {
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "m", name: "m" },
    thinkingLevel: "off",
    isIdle: () => true,
    getContextUsage: () => null,
    modelRegistry: { find: () => undefined },
    abort() {},
    compact() {},
    sessionManager: {
      getSessionId: () => SESSION,
      getEntries: () => store.entries,
      getLeafId: () => store.entries.at(-1)?.id ?? null,
    },
  };
}

function fakePi() {
  const handlers = {};
  const commands = {};
  return {
    handlers,
    commands,
    on(type, fn) {
      (handlers[type] ??= []).push(fn);
    },
    registerCommand(name, options) {
      commands[name] = options;
    },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    events: { emit() {}, on() {} },
    getSessionName: () => "host-ext-test",
    sendUserMessage() {},
    setModel: async () => true,
    setThinkingLevel() {},
    setSessionName() {},
  };
}

let coord;
let account;
let dir;

beforeEach(async () => {
  coord = await startCoordinator();
  account = makeAccount(coord.accounts, "hostext@example.com");
  dir = mkdtempSync(join(tmpdir(), "pinet-hostext-"));
});

afterEach(async () => {
  await coord.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PINET_DIR;
  delete process.env.PINET_HUB;
  delete process.env.PINET_HTTP;
  delete process.env.PINET_SPAWN_MODE;
});

describe("host extension delta streaming", () => {
  it("publishes entries created after the initial snapshot", async () => {
    const enrolled = enrollDevice(coord.accounts, account.id, "host", "h");
    writeFileSync(
      join(dir, "host.json"),
      JSON.stringify({ hostId: enrolled.device.id, identity: enrolled.identity, encryption: enrolled.encryption }),
    );
    process.env.PINET_DIR = dir;
    process.env.PINET_HUB = coord.url;
    process.env.PINET_HTTP = coord.httpUrl;

    const pi = fakePi();
    hostExtension(pi);

    const store = { entries: [{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "first" } }] };
    await pi.handlers.session_start[0]({}, makeCtx(store));

    const ctl = enrollDevice(coord.accounts, account.id, "controller", "c");
    const controller = new PinetController({ url: coord.url, deviceId: ctl.device.id, identity: ctl.identity, encryption: ctl.encryption });
    await controller.connect();

    let sessionId;
    for (let i = 0; i < 120 && !sessionId; i += 1) {
      sessionId = (await controller.list())[0]?.sessionId;
      if (!sessionId) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(sessionId).toBe(SESSION);

    const snapshot = waitFor(controller, "snapshot");
    await controller.attach(SESSION, "control");
    await snapshot;

    // A new entry, delivered via a *different* ctx object.
    store.entries.push({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "second" }] } });
    const entries = waitFor(controller, "entries", (data) => data.entries?.some((entry) => entry.id === "e2"));
    await pi.handlers.message_end[0]({}, makeCtx(store));
    expect((await entries).entries.map((entry) => entry.id)).toContain("e2");

    controller.close();
  });

  async function enrollHostTest(name) {
    const enrolled = enrollDevice(coord.accounts, account.id, "host", name);
    writeFileSync(
      join(dir, "host.json"),
      JSON.stringify({ hostId: enrolled.device.id, identity: enrolled.identity, encryption: enrolled.encryption }),
    );
    process.env.PINET_DIR = dir;
    process.env.PINET_HUB = coord.url;
    process.env.PINET_HTTP = coord.httpUrl;
    const pi = fakePi();
    hostExtension(pi);
    await pi.handlers.session_start[0]({}, makeCtx({ entries: [] }));

    const ctl = enrollDevice(coord.accounts, account.id, "controller", `${name}-ctl`);
    const controller = new PinetController({ url: coord.url, deviceId: ctl.device.id, identity: ctl.identity, encryption: ctl.encryption });
    await controller.connect();
    for (let i = 0; i < 120; i += 1) {
      if ((await controller.list()).some((session) => session.sessionId === SESSION)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return controller;
  }

  it("advertises spawn capability in session meta", async () => {
    const controller = await enrollHostTest("cap");
    const session = (await controller.list()).find((entry) => entry.sessionId === SESSION);
    expect(session.meta.spawn).toMatchObject({ mode: "session", cwd: "/tmp" });
    controller.close();
  });

  it("routes a spawn command to the host and rejects when disabled", async () => {
    process.env.PINET_SPAWN_MODE = "off";
    const controller = await enrollHostTest("spawn-off");
    await controller.attach(SESSION, "control");
    const ack = await controller.command(SESSION, "spawn", {});
    expect(ack).toMatchObject({ accepted: false, error: "spawn_disabled" });
    controller.close();
  });
});
