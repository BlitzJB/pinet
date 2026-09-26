import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiNetController } from "../../src/controller/client.mjs";
import { HostBridge } from "../../src/host/bridge.mjs";
import { enrollDevice, makeAccount, startCoordinator, waitFor } from "../helpers/harness.mjs";

let coord;
let account;

beforeEach(async () => {
  coord = await startCoordinator();
  account = makeAccount(coord.accounts, "multi@example.com");
});

afterEach(async () => {
  await coord.close();
});

function makeHost(name) {
  const enrolled = enrollDevice(coord.accounts, account.id, "host", name);
  const bridge = new HostBridge({
    url: coord.url,
    deviceId: enrolled.device.id,
    identity: enrolled.identity,
    encryption: enrolled.encryption,
    hostName: name,
  });
  bridge.setSnapshotProvider(() => ({ entries: [], status: { phase: "idle" }, meta: { name } }));
  return bridge;
}

async function makeController(name) {
  const enrolled = enrollDevice(coord.accounts, account.id, "controller", name);
  const controller = new PiNetController({
    url: coord.url,
    deviceId: enrolled.device.id,
    identity: enrolled.identity,
    encryption: enrolled.encryption,
  });
  await controller.connect();
  return controller;
}

describe("multiple hosts", () => {
  it("routes sessions across hosts independently", async () => {
    const hostA = makeHost("host-a");
    const hostB = makeHost("host-b");
    await hostA.connect();
    await hostB.connect();
    hostA.openSession({ sessionId: "s_a", meta: { name: "A" } });
    hostB.openSession({ sessionId: "s_b", meta: { name: "B" } });

    const controller = await makeController("viewer");
    const catalog = await controller.list();
    expect(catalog.map((s) => s.sessionId).sort()).toEqual(["s_a", "s_b"]);
    expect(new Set(catalog.map((s) => s.hostId)).size).toBe(2);

    await controller.attach("s_a", "control");
    await controller.attach("s_b", "control");

    const aEntries = waitFor(controller, "entries", (d) => d.sessionId === "s_a");
    const bEntries = waitFor(controller, "entries", (d) => d.sessionId === "s_b");
    hostA.publishEntries([{ type: "message", id: "a1", parentId: null, message: { role: "user", content: "from A" } }]);
    hostB.publishEntries([{ type: "message", id: "b1", parentId: null, message: { role: "user", content: "from B" } }]);
    expect((await aEntries).entries[0].id).toBe("a1");
    expect((await bEntries).entries[0].id).toBe("b1");

    controller.close();
    hostA.close();
    hostB.close();
  });

  it("rejects a controller from another account", async () => {
    const host = makeHost("private-host");
    await host.connect();
    host.openSession({ sessionId: "s_private" });

    const otherAccount = makeAccount(coord.accounts, "other@example.com");
    const outsider = enrollDevice(coord.accounts, otherAccount.id, "controller", "outsider");
    const controller = new PiNetController({
      url: coord.url,
      deviceId: outsider.device.id,
      identity: outsider.identity,
      encryption: outsider.encryption,
    });
    await controller.connect();
    const catalog = await controller.list();
    expect(catalog).toEqual([]);
    controller.close();
    host.close();
  });
});
