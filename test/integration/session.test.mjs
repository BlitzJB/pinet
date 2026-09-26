import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/common/canonical.mjs";
import { PiNetController } from "../../src/controller/client.mjs";
import { commandAad, sealJson } from "../../src/crypto/e2e.mjs";
import { sign } from "../../src/crypto/keys.mjs";
import { HostBridge } from "../../src/host/bridge.mjs";
import { enrollDevice, makeAccount, startCoordinator, waitFor } from "../helpers/harness.mjs";

const SESSION = "s_integration_1";
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: Date.now(), message });

let coord;
let account;

beforeEach(async () => {
  coord = await startCoordinator();
  account = makeAccount(coord.accounts, "user@example.com");
});

afterEach(async () => {
  await coord.close();
});

function makeHost(name = "studio") {
  const enrolled = enrollDevice(coord.accounts, account.id, "host", name);
  const bridge = new HostBridge({
    url: coord.url,
    deviceId: enrolled.device.id,
    identity: enrolled.identity,
    encryption: enrolled.encryption,
    hostName: name,
  });
  const store = { entries: [], status: { phase: "idle", isIdle: true }, meta: { name: "demo" } };
  bridge.setSnapshotProvider(() => ({ entries: store.entries, status: store.status, meta: store.meta }));
  return { bridge, store, device: enrolled.device };
}

async function makeController(name) {
  const enrolled = enrollDevice(coord.accounts, account.id, "controller", name);
  const controller = new PiNetController({
    url: coord.url,
    deviceId: enrolled.device.id,
    identity: enrolled.identity,
    encryption: enrolled.encryption,
    deviceName: name,
  });
  await controller.connect();
  return controller;
}

function rawCommand(controller, { commandId, op, args, epoch }) {
  const keyed = controller.keys.get(SESSION);
  const commandEpoch = epoch ?? keyed.epoch;
  const enc = sealJson(
    keyed.key,
    args,
    commandAad({ sessionId: SESSION, commandId, epoch: commandEpoch, op, deviceId: controller.deviceId }),
  );
  const sig = sign(
    canonicalJson({ sessionId: SESSION, commandId, epoch: commandEpoch, op, deviceId: controller.deviceId, enc }),
    controller.identity.privateKey,
  );
  return { sessionId: SESSION, commandId, epoch: commandEpoch, op, enc, sig };
}

function nextAck(controller) {
  return waitFor(controller.socket, "cmd.ack");
}

describe("authenticated session + end-to-end commands", () => {
  it("authenticates, attaches, unwraps the key and decrypts an encrypted snapshot", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION, meta: { name: "demo" } });

    const controller = await makeController("phone");
    const snapshotPromise = waitFor(controller, "snapshot");
    await controller.attach(SESSION, "control");
    const snapshot = await snapshotPromise;
    expect(snapshot.sessionId).toBe(SESSION);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.status.phase).toBe("idle");
    controller.close();
    host.bridge.close();
  });

  it("fans out encrypted entries to multiple controllers", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });

    const a = await makeController("a");
    const b = await makeController("b");
    await a.attach(SESSION, "control");
    await b.attach(SESSION, "control");

    const aEntries = waitFor(a, "entries");
    const bEntries = waitFor(b, "entries");
    host.bridge.publishEntries([entry("e1", null, { role: "user", content: "hi" })]);
    expect((await aEntries).entries[0].id).toBe("e1");
    expect((await bEntries).entries[0].id).toBe("e1");

    a.close();
    b.close();
    host.bridge.close();
  });

  it("round-trips a signed, encrypted command and reports immediate/steer mode", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    const received = [];
    host.bridge.onCommand(async ({ op, args }) => {
      received.push({ op, args });
      return { accepted: true, mode: args.text === "steer me" ? "steer" : "immediate" };
    });

    const controller = await makeController("phone");
    await controller.attach(SESSION, "control");

    const immediate = await controller.command(SESSION, "prompt", { text: "hello" });
    expect(immediate).toMatchObject({ accepted: true, mode: "immediate" });
    const steer = await controller.command(SESSION, "prompt", { text: "steer me" });
    expect(steer).toMatchObject({ accepted: true, mode: "steer" });
    expect(received.map((r) => r.args.text)).toEqual(["hello", "steer me"]);

    controller.close();
    host.bridge.close();
  });

  it("rejects a read-only controller", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("wall");
    await controller.attach(SESSION, "read");
    const ack = await controller.command(SESSION, "prompt", { text: "nope" });
    expect(ack).toMatchObject({ accepted: false, error: "read_only" });
    controller.close();
    host.bridge.close();
  });

  it("rejects a tampered command signature", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    host.bridge.onCommand(async () => ({ accepted: true, mode: "immediate" }));
    const controller = await makeController("phone");
    await controller.attach(SESSION, "control");

    const command = rawCommand(controller, { commandId: "c-tamper", op: "prompt", args: { text: "x" } });
    command.enc = { ...command.enc, ct: Buffer.from("tampered").toString("base64") };
    const ack = nextAck(controller);
    controller.socket.send("ctl.command", command);
    expect(await ack).toMatchObject({ accepted: false, error: "bad_signature" });
    controller.close();
    host.bridge.close();
  });

  it("rejects a stale epoch", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    host.bridge.onCommand(async () => ({ accepted: true, mode: "immediate" }));
    const controller = await makeController("phone");
    await controller.attach(SESSION, "control");

    const command = rawCommand(controller, { commandId: "c-epoch", op: "prompt", args: { text: "x" }, epoch: 99 });
    const ack = nextAck(controller);
    controller.socket.send("ctl.command", command);
    expect(await ack).toMatchObject({ accepted: false, error: "stale_epoch" });
    controller.close();
    host.bridge.close();
  });

  it("is idempotent for a repeated command id", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    let calls = 0;
    host.bridge.onCommand(async () => {
      calls += 1;
      return { accepted: true, mode: "immediate" };
    });
    const controller = await makeController("phone");
    await controller.attach(SESSION, "control");

    const command = rawCommand(controller, { commandId: "c-once", op: "prompt", args: { text: "once" } });
    const first = nextAck(controller);
    controller.socket.send("ctl.command", command);
    expect(await first).toMatchObject({ accepted: true });
    const second = nextAck(controller);
    controller.socket.send("ctl.command", command);
    expect(await second).toMatchObject({ accepted: true });
    expect(calls).toBe(1);
    controller.close();
    host.bridge.close();
  });

  it("reflects host offline in the catalog", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("phone");
    await controller.attach(SESSION, "read");
    host.bridge.close();
    await waitFor(controller.socket, "closed", () => true, 3000).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const sessions = await controller.list();
    expect(sessions.find((s) => s.sessionId === SESSION)?.hostConnected).toBe(false);
    controller.close();
  });

  it("persists host meta updates in the catalog (rename)", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION, meta: { name: "demo", cwd: "/srv", host: "studio" } });
    const controller = await makeController("renamer");
    await controller.attach(SESSION, "control");
    await controller.list();

    host.bridge.publishMeta({ name: "Fix the login flow", cwd: "/srv", host: "studio" });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const sessions = await controller.list();
    expect(sessions.find((s) => s.sessionId === SESSION)?.meta?.name).toBe("Fix the login flow");
    controller.close();
    host.bridge.close();
  });

  it("round-trips extra ack data from a host command (spawn)", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    host.bridge.onCommand(async (command) => {
      if (command.op !== "spawn") return { accepted: false, mode: null, error: "unknown_op" };
      return { accepted: true, mode: "immediate", data: { sessionId: "spawned-1", name: "child" } };
    });
    const controller = await makeController("spawner");
    await controller.attach(SESSION, "control");
    const ack = await controller.command(SESSION, "spawn", { name: "child" });
    expect(ack).toMatchObject({ accepted: true, data: { sessionId: "spawned-1", name: "child" } });
    controller.close();
    host.bridge.close();
  });

  it("rejects a command from an unattached controller", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("detached");
    await controller.attach(SESSION, "control");
    controller.detach(SESSION);
    const ack = await controller.command(SESSION, "prompt", { text: "x" });
    expect(ack).toMatchObject({ accepted: false, error: "not_attached" });
    controller.close();
    host.bridge.close();
  });

  it("rejects a command when the host is offline", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("offline");
    await controller.attach(SESSION, "control");
    host.bridge.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const ack = await controller.command(SESSION, "prompt", { text: "x" });
    expect(ack).toMatchObject({ accepted: false, error: "host_unavailable" });
    controller.close();
  });

  it("delivers a rebase frame after compaction/navigation", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("rebase");
    await controller.attach(SESSION, "control");
    const rebasePromise = waitFor(controller, "rebase");
    host.bridge.publishRebase([{ type: "message", id: "r1", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }]);
    expect((await rebasePromise).entries[0].id).toBe("r1");
    controller.close();
    host.bridge.close();
  });

  it("gives a late joiner a fresh snapshot with current entries", async () => {
    const host = makeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    const first = await makeController("early");
    await first.attach(SESSION, "control");

    host.store.entries = [entry("e1", null, { role: "user", content: "first" })];
    const firstEntries = waitFor(first, "entries");
    host.bridge.publishEntries(host.store.entries);
    await firstEntries;

    const late = await makeController("late");
    const snapshotPromise = waitFor(late, "snapshot", (d) => d.entries?.some((e) => e.id === "e1"));
    await late.attach(SESSION, "read");
    const snapshot = await snapshotPromise;
    expect(snapshot.entries.map((e) => e.id)).toContain("e1");

    first.close();
    late.close();
    host.bridge.close();
  });
});
