import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hostExtension from "../../extension/index.ts";
import { PiNetController } from "../../src/controller/client.mjs";
import { enrollDevice, makeAccount, startCoordinator, waitFor } from "../helpers/harness.mjs";

const SESSION = "s_hostext";

// pi hands a *fresh* context object to each handler; reproduce that here.
function makeCtx(store, options = {}) {
  // A mutable box so a test can flip pi's idleness without another event firing,
  // which is exactly how the run loop settles after a compaction.
  const idle = options.idle ?? { value: true };
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "m", name: "m" },
    thinkingLevel: "off",
    isIdle: () => idle.value,
    getContextUsage: () => null,
    scopedModels: [],
    modelRegistry: {
      find: () => undefined,
      getProviderDisplayName: (provider) => (provider === "test" ? "Test Provider" : provider),
      getAvailable: () => [
        { provider: "test", id: "m", name: "Test Model", reasoning: true, contextWindow: 200000 },
        { provider: "other", id: "x", name: "Other Model", reasoning: false, contextWindow: 128000 },
      ],
    },
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
  delete process.env.PINET_STATUS_SETTLE_MS;
  delete process.env.PINET_STATUS_SETTLE_MAX_MS;
  delete process.env.PINET_STATUS_HEARTBEAT_MS;
  delete process.env.PINET_COMPACT_STALE_MS;
});

// --- shared setup for the status/compaction tests ---------------------------

/** Attach a controller to a host extension whose pi context the test controls. */
async function attachHostTest(name, entries = []) {
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
  const idle = { value: true };
  const store = { entries };
  await pi.handlers.session_start[0]({}, makeCtx(store, { idle }));

  const ctl = enrollDevice(coord.accounts, account.id, "controller", `${name}-ctl`);
  const controller = new PiNetController({ url: coord.url, deviceId: ctl.device.id, identity: ctl.identity, encryption: ctl.encryption });
  await controller.connect();
  for (let i = 0; i < 120; i += 1) {
    if ((await controller.list()).some((session) => session.sessionId === SESSION)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const snapshot = waitFor(controller, "snapshot", () => true, 10_000);
  await controller.attach(SESSION, "control");
  await snapshot;
  return { pi, controller, store, idle };
}

/** Resolve with the first status frame whose payload satisfies `predicate`. */
async function waitForStatus(controller, predicate, timeoutMs = 5000) {
  const data = await waitFor(controller, "status", (frame) => predicate(frame.status), timeoutMs);
  return data.status;
}

describe("host extension run state", () => {
  const entries500 = () =>
    Array.from({ length: 500 }, (_, i) => ({
      type: "message",
      id: `c${i}`,
      parentId: i ? `c${i - 1}` : null,
      message: { role: "user", content: `m ${i}` },
    }));

  it("settles the run state after a compaction finishes", async () => {
    // pi emits `session_compact` while the run loop is still settling, so the
    // status published there still says "running" even though no run is in
    // flight. Nothing else ever publishes, so the host has to keep nudging status
    // until pi is idle — otherwise the controller shows a status line forever
    // (this was a real report: compaction completed, the indicator kept spinning).
    process.env.PINET_STATUS_SETTLE_MS = "30";
    process.env.PINET_STATUS_SETTLE_MAX_MS = "3000";
    const { pi, controller, store, idle } = await attachHostTest("settle", entries500());

    idle.value = false;
    await pi.handlers.session_before_compact[0]({ reason: "manual" }, makeCtx(store, { idle }));
    expect(await waitForStatus(controller, (s) => Boolean(s?.compacting))).toMatchObject({
      compacting: { reason: "manual" },
    });

    await pi.handlers.session_compact[0]({ reason: "manual" }, makeCtx(store, { idle }));
    const cleared = await waitForStatus(controller, (s) => s?.compacting === null);
    // The flag clears, but pi has not settled yet: this is the state the old code
    // stopped at, leaving the indicator up with nothing left to correct it.
    expect(cleared.isIdle).toBe(false);

    // pi finishes settling with no further event: the host must notice on its own.
    idle.value = true;
    expect((await waitForStatus(controller, (s) => s?.isIdle === true)).isIdle).toBe(true);
    controller.close();
  });

  it("re-anchors paging with a windowed rebase instead of shipping everything", async () => {
    // A rebase used to fan out every raw entry: compacting a 9 MB session pushed
    // 2533 entries / 9.2 MB at the controller and silently undid paging.
    const { pi, controller, store } = await attachHostTest("rebase", entries500());
    const rebase = waitFor(controller, "rebase", () => true, 10_000);
    await pi.handlers.session_compact[0]({ reason: "manual" }, makeCtx(store));
    const frame = await rebase;
    expect(frame.entries).toHaveLength(200);
    expect(frame.entries.at(-1).id).toBe("c499");
    expect(frame.history).toMatchObject({ cursor: 300, hasMore: true, total: 500 });
    controller.close();
  });

  it("heartbeats status while a run is in flight and goes quiet when idle", async () => {
    // Status only travels on host frames, so a run that publishes nothing for
    // minutes (a long generation) or whose frame is lost would strand the UI.
    process.env.PINET_STATUS_HEARTBEAT_MS = "40";
    const { pi, controller, store, idle } = await attachHostTest("heartbeat", []);
    const seen = [];
    controller.on("status", (data) => seen.push(data.status));

    idle.value = false;
    await pi.handlers.agent_start[0]({}, makeCtx(store, { idle }));
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(seen.filter((s) => s?.isIdle === false).length).toBeGreaterThanOrEqual(2);

    idle.value = true;
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(seen.at(-1)?.isIdle).toBe(true);
    const count = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(seen.length).toBe(count); // silent once idle
    controller.close();
  });
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
    const controller = new PiNetController({ url: coord.url, deviceId: ctl.device.id, identity: ctl.identity, encryption: ctl.encryption });
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

  async function enrollHostTest(name, { waitForSession = true } = {}) {
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
    const controller = new PiNetController({ url: coord.url, deviceId: ctl.device.id, identity: ctl.identity, encryption: ctl.encryption });
    await controller.connect();
    if (waitForSession) {
      for (let i = 0; i < 120; i += 1) {
        if ((await controller.list()).some((session) => session.sessionId === SESSION)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return controller;
  }

  it("advertises spawn capability in session meta", async () => {
    const controller = await enrollHostTest("cap");
    const session = (await controller.list()).find((entry) => entry.sessionId === SESSION);
    expect(session.meta.spawn).toMatchObject({ mode: "session", cwd: "/tmp" });
    controller.close();
  });

  it("lists the models the host can run", async () => {
    const controller = await enrollHostTest("models");
    await controller.attach(SESSION, "control");
    const ack = await controller.command(SESSION, "list_models", {});
    expect(ack.accepted).toBe(true);
    const models = ack.data.models;
    expect(models.map((m) => `${m.provider}/${m.id}`).sort()).toEqual(["other/x", "test/m"]);
    expect(models.find((m) => m.id === "m")).toMatchObject({
      name: "Test Model",
      providerName: "Test Provider",
      reasoning: true,
      contextWindow: 200000,
    });
    expect(ack.data.current).toEqual({ provider: "test", id: "m" });
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

  it("stays inert inside a subagent child process", async () => {
    // pi-subagents marks children with PI_SUBAGENT_CHILD=1. A child is part of a
    // parent's run, so pinet must not open its own host connection or session.
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      const controller = await enrollHostTest("child", { waitForSession: false });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(coord.registry.stats().hosts).toBe(0);
      expect(await controller.list()).toEqual([]);
      controller.close();
    } finally {
      delete process.env.PI_SUBAGENT_CHILD;
    }
  });

  it("ships only a tail and pages older history on demand", async () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      type: "message",
      id: `e${i}`,
      parentId: i ? `e${i - 1}` : null,
      message: { role: "user", content: `msg ${i}` },
    }));

    const enrolled = enrollDevice(coord.accounts, account.id, "host", "paging");
    writeFileSync(
      join(dir, "host.json"),
      JSON.stringify({ hostId: enrolled.device.id, identity: enrolled.identity, encryption: enrolled.encryption }),
    );
    process.env.PINET_DIR = dir;
    process.env.PINET_HUB = coord.url;
    process.env.PINET_HTTP = coord.httpUrl;

    const pi = fakePi();
    hostExtension(pi);
    await pi.handlers.session_start[0]({}, makeCtx({ entries }));

    const ctl = enrollDevice(coord.accounts, account.id, "controller", "paging-ctl");
    const controller = new PiNetController({ url: coord.url, deviceId: ctl.device.id, identity: ctl.identity, encryption: ctl.encryption });
    await controller.connect();

    const snapshot = waitFor(controller, "snapshot", () => true, 10_000);
    await controller.attach(SESSION, "control");
    const first = await snapshot;
    // Only the newest 200 of 500 entries, plus a cursor for the rest.
    expect(first.entries).toHaveLength(200);
    expect(first.entries[0].id).toBe("e300");
    expect(first.history).toMatchObject({ cursor: 300, hasMore: true, total: 500 });

    const page = waitFor(controller, "page", () => true, 10_000);
    const ack = await controller.command(SESSION, "history", { before: 300 });
    expect(ack).toMatchObject({ accepted: true, data: { cursor: 150, hasMore: true, returned: 150 } });
    const older = await page;
    expect(older.entries).toHaveLength(150);
    expect(older.entries[0].id).toBe("e150");
    expect(older.history).toMatchObject({ cursor: 150, hasMore: true });

    // The final page reports the start of the transcript.
    const last = waitFor(controller, "page", (data) => data.history?.hasMore === false, 10_000);
    await controller.command(SESSION, "history", { before: 150 });
    expect((await last).entries[0].id).toBe("e0");
    controller.close();
  });
});
