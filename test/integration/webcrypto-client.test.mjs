import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiNetController } from "../../src/controller/client.mjs";
import { webCryptoProvider } from "../../src/crypto/webcrypto.mjs";
import { HostBridge } from "../../src/host/bridge.mjs";
import { enrollDevice, makeAccount, startCoordinator, waitFor } from "../helpers/harness.mjs";

const SESSION = "s_webcrypto";

let coord;
let account;

beforeEach(async () => {
  coord = await startCoordinator();
  account = makeAccount(coord.accounts, "web@example.com");
});

afterEach(async () => {
  await coord.close();
});

async function makeNodeHost() {
  const enrolled = enrollDevice(coord.accounts, account.id, "host", "node-host");
  const bridge = new HostBridge({
    url: coord.url,
    deviceId: enrolled.device.id,
    identity: enrolled.identity,
    encryption: enrolled.encryption,
    hostName: "node-host",
  });
  bridge.setSnapshotProvider(() => ({ entries: [{ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }], status: { phase: "idle" }, meta: { name: "web-test" } }));
  return { bridge };
}

async function makeWebController(name) {
  // Generate device keys entirely with WebCrypto, as a browser client would.
  const identity = await webCryptoProvider.generateIdentityKeypair();
  const encryption = await webCryptoProvider.generateEncryptionKeypair();
  const device = coord.accounts.registerDevice({
    accountId: account.id,
    kind: "controller",
    name,
    identityPub: await webCryptoProvider.exportPublicKey(identity.publicKey),
    encPub: await webCryptoProvider.exportPublicKey(encryption.publicKey),
  });
  const controller = new PiNetController({
    url: coord.url,
    deviceId: device.id,
    identity,
    encryption,
    deviceName: name,
    crypto: webCryptoProvider,
  });
  await controller.connect();
  return controller;
}

describe("webcrypto client (browser-style)", () => {
  it("authenticates, decrypts frames and sends commands to a node host", async () => {
    const host = await makeNodeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION, meta: { name: "web-test" } });

    const controller = await makeWebController("browser");
    const catalog = await controller.list();
    expect(catalog.some((s) => s.sessionId === SESSION)).toBe(true);

    const snapshotPromise = waitFor(controller, "snapshot");
    await controller.attach(SESSION, "control");
    const snapshot = await snapshotPromise;
    expect(snapshot.entries[0].id).toBe("e1");

    const received = [];
    host.bridge.onCommand(async ({ op, args }) => {
      received.push({ op, args });
      return { accepted: true, mode: "steer" };
    });
    const ack = await controller.command(SESSION, "prompt", { text: "from webcrypto" });
    expect(ack).toMatchObject({ accepted: true, mode: "steer" });
    expect(received[0].args.text).toBe("from webcrypto");

    controller.close();
    host.bridge.close();
  });

  it("rejects a webcrypto command signed with a different key", async () => {
    const host = await makeNodeHost();
    await host.bridge.connect();
    host.bridge.openSession({ sessionId: SESSION });
    host.bridge.onCommand(async () => ({ accepted: true, mode: "immediate" }));

    const controller = await makeWebController("attacker");
    await controller.attach(SESSION, "control");

    // Tamper with the ciphertext; the signature no longer matches.
    const entry = controller.keys.get(SESSION);
    const { sealJson } = await import("../../src/crypto/session-crypto.mjs");
    const { commandAad } = await import("../../src/crypto/aad.mjs");
    const { canonicalJson } = await import("../../src/common/canonical.mjs");
    const commandId = "tampered-1";
    const enc = await sealJson(webCryptoProvider, entry.key, { text: "x" }, commandAad({ sessionId: SESSION, commandId, epoch: entry.epoch, op: "prompt", deviceId: controller.deviceId }));
    const tampered = { ...enc, ct: Buffer.from("nope").toString("base64") };
    const sig = await webCryptoProvider.sign(
      canonicalJson({ sessionId: SESSION, commandId, epoch: entry.epoch, op: "prompt", deviceId: controller.deviceId, enc: tampered }),
      controller.identity.privateKey,
    );
    const ack = waitFor(controller.socket, "cmd.ack");
    controller.socket.send("ctl.command", { sessionId: SESSION, commandId, epoch: entry.epoch, op: "prompt", enc: tampered, sig });
    expect(await ack).toMatchObject({ accepted: false, error: "decrypt_failed" });

    controller.close();
    host.bridge.close();
  });
});
