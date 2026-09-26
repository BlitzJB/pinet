import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiNetController } from "../../src/controller/client.mjs";
import { HostBridge } from "../../src/host/bridge.mjs";
import { enrollDevice, makeAccount, startCoordinator, waitFor } from "../helpers/harness.mjs";

const SESSION = "s_reconnect";

let coord;
let account;

beforeEach(async () => {
  coord = await startCoordinator();
  account = makeAccount(coord.accounts, "reconnect@example.com");
});

afterEach(async () => {
  await coord.close();
});

function makeHost(name = "host", reuse) {
  const enrolled = reuse ?? enrollDevice(coord.accounts, account.id, "host", name);
  const bridge = new HostBridge({
    url: coord.url,
    deviceId: enrolled.device.id,
    identity: enrolled.identity,
    encryption: enrolled.encryption,
    hostName: name,
  });
  const store = { entries: [], status: { phase: "idle" } };
  bridge.setSnapshotProvider(() => ({ entries: store.entries, status: store.status, meta: { name } }));
  return { bridge, store, enrolled };
}

async function makeController(name, reconnect) {
  const enrolled = enrollDevice(coord.accounts, account.id, "controller", name);
  const controller = new PiNetController({
    url: coord.url,
    deviceId: enrolled.device.id,
    identity: enrolled.identity,
    encryption: enrolled.encryption,
    reconnect,
  });
  await controller.connect();
  return controller;
}

describe("network resilience", () => {
  it("host reconnects, re-keys, and controllers get a fresh snapshot and can command", async () => {
    const { bridge } = makeHost();
    await bridge.connect();
    bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("ctl-host-drop", true);
    await controller.attach(SESSION, "control");
    const firstEpoch = controller.getSnapshot(SESSION).epoch;

    const reconnected = waitFor(bridge, "reconnected", () => true, 15_000);
    bridge.socket.ws.close(); // simulate an uncontrolled network drop
    await reconnected;

    const snapshot = await waitFor(controller, "snapshot", (data) => data.epoch > firstEpoch, 15_000);
    expect(snapshot.epoch).toBeGreaterThan(firstEpoch);

    bridge.onCommand(async () => ({ accepted: true, mode: "immediate" }));
    const ack = await controller.command(SESSION, "prompt", { text: "after host reconnect" });
    expect(ack).toMatchObject({ accepted: true });

    controller.close();
    bridge.close();
  });

  it("controller reconnects, re-attaches, and can command", async () => {
    const { bridge } = makeHost();
    await bridge.connect();
    bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("ctl-drop", true);
    await controller.attach(SESSION, "control");

    const resynced = waitFor(controller, "resynced", () => true, 15_000);
    controller.socket.ws.close();
    await resynced;

    bridge.onCommand(async () => ({ accepted: true, mode: "steer" }));
    const ack = await controller.command(SESSION, "prompt", { text: "after controller reconnect" });
    expect(ack).toMatchObject({ accepted: true, mode: "steer" });

    controller.close();
    bridge.close();
  });

  it("a command issued while the controller is dropping succeeds after reconnect", async () => {
    const { bridge } = makeHost();
    await bridge.connect();
    bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("ctl-mid", true);
    await controller.attach(SESSION, "control");
    bridge.onCommand(async () => ({ accepted: true, mode: "immediate" }));

    controller.socket.ws.close();
    const ack = await controller.command(SESSION, "prompt", { text: "during drop" });
    expect(ack).toMatchObject({ accepted: true });

    controller.close();
    bridge.close();
  });

  it("detects a sequence gap and resyncs with a fresh snapshot", async () => {
    const { bridge } = makeHost();
    await bridge.connect();
    bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("ctl-gap", true);
    await controller.attach(SESSION, "control");

    const gaps = [];
    controller.on("gap", (data) => gaps.push(data));

    bridge.publishStatus({ phase: "idle" });
    bridge.session.seq += 5; // simulate dropped durable frames
    const resynced = waitFor(controller, "resynced", () => true, 15_000);
    bridge.publishStatus({ phase: "running" });

    await resynced;
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]).toMatchObject({ sessionId: SESSION });

    controller.close();
    bridge.close();
  });

  it("re-keys an already-attached controller when the host process restarts", async () => {
    const host1 = makeHost("restart-host");
    await host1.bridge.connect();
    host1.bridge.openSession({ sessionId: SESSION, meta: { name: "demo" } });
    const controller = await makeController("ctl-restart", true);
    await controller.attach(SESSION, "control");
    await controller.list();

    // A full process restart: same host identity, brand-new bridge with no
    // memory of the existing attachment.
    const key = waitFor(controller, "key", (data) => data.sessionId === SESSION, 15_000);
    const snapshot = waitFor(controller, "snapshot", () => true, 15_000);
    host1.bridge.close();
    const host2 = makeHost("restart-host", host1.enrolled);
    await host2.bridge.connect();
    host2.bridge.openSession({ sessionId: SESSION, meta: { name: "demo" } });

    await key;
    await snapshot;

    host2.bridge.onCommand(async () => ({ accepted: true, mode: "immediate" }));
    const ack = await controller.command(SESSION, "prompt", { text: "after restart" });
    expect(ack).toMatchObject({ accepted: true });

    controller.close();
    host2.bridge.close();
  });

  it("does not reconnect when closed deliberately", async () => {
    const { bridge } = makeHost();
    await bridge.connect();
    bridge.openSession({ sessionId: SESSION });
    const controller = await makeController("ctl-close", true);
    await controller.attach(SESSION, "control");

    let reconnected = false;
    controller.on("reconnected", () => (reconnected = true));
    controller.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(reconnected).toBe(false);
    expect(controller.socket.ready).toBe(false);

    bridge.close();
  });
});
