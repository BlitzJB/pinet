import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiNetController } from "../../src/controller/client.mjs";
import { HostBridge } from "../../src/host/bridge.mjs";
import { enrollDevice, makeAccount, startCoordinator, waitFor } from "../helpers/harness.mjs";

let coord;
let account;

beforeEach(async () => {
  coord = await startCoordinator();
  account = makeAccount(coord.accounts, "shared@example.com");
});

afterEach(async () => {
  await coord.close();
});

describe("multiple host connections sharing one device identity", () => {
  it("routes each session to its own connection", async () => {
    // One machine identity (same deviceId + keys), two pi processes.
    const enrolled = enrollDevice(coord.accounts, account.id, "host", "machine");
    const makeBridge = async (sessionId, text) => {
      const bridge = new HostBridge({
        url: coord.url,
        deviceId: enrolled.device.id,
        identity: enrolled.identity,
        encryption: enrolled.encryption,
        hostName: "machine",
      });
      bridge.setSnapshotProvider(() => ({ entries: [], status: { phase: "idle" }, meta: { name: text } }));
      bridge.onCommand(async () => ({ accepted: true, mode: "immediate" }));
      await bridge.connect();
      bridge.openSession({ sessionId, meta: { name: text } });
      return bridge;
    };

    const bridgeA = await makeBridge("s_machine_a", "A");
    const bridgeB = await makeBridge("s_machine_b", "B");

    const controllerEnrollment = enrollDevice(coord.accounts, account.id, "controller", "ctl");
    const controller = new PiNetController({
      url: coord.url,
      deviceId: controllerEnrollment.device.id,
      identity: controllerEnrollment.identity,
      encryption: controllerEnrollment.encryption,
    });
    await controller.connect();

    const catalog = await controller.list();
    expect(catalog.map((session) => session.sessionId).sort()).toEqual(["s_machine_a", "s_machine_b"]);
    expect(catalog.every((session) => session.hostConnected)).toBe(true);

    await controller.attach("s_machine_a", "control");
    await controller.attach("s_machine_b", "control");

    // Frames from A only reach session A's subscribers.
    const aEntries = waitFor(controller, "entries", (data) => data.sessionId === "s_machine_a");
    const bEntries = waitFor(controller, "entries", (data) => data.sessionId === "s_machine_b");
    bridgeA.publishEntries([{ type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "from A" }] } }]);
    bridgeB.publishEntries([{ type: "message", id: "b1", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "from B" }] } }]);
    expect((await aEntries).entries[0].id).toBe("a1");
    expect((await bEntries).entries[0].id).toBe("b1");

    // Commands route to the owning connection (both must ack).
    expect(await controller.command("s_machine_a", "prompt", { text: "hi A" })).toMatchObject({ accepted: true });
    expect(await controller.command("s_machine_b", "prompt", { text: "hi B" })).toMatchObject({ accepted: true });

    controller.close();
    bridgeA.close();
    bridgeB.close();
  });
});
