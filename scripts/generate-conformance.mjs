import { mkdirSync, writeFileSync } from "node:fs";
import { canonicalJson } from "../src/common/canonical.mjs";
import { commandAad, frameAad } from "../src/crypto/aad.mjs";
import { nodeCryptoProvider } from "../src/crypto/provider.mjs";
import { sealJson, wrapGroupKey } from "../src/crypto/session-crypto.mjs";

const p = nodeCryptoProvider;
const serverId = "srv_conformance";
const deviceId = "dev_conformance";
const role = "controller";
const nonce = "conformance-nonce";
const timestamp = 1_700_000_000_000;

const identity = await p.generateIdentityKeypair();
const signature = await p.sign(canonicalJson({ nonce, serverId, timestamp, role, deviceId }), identity.privateKey);

const groupKey = p.randomBytes(32);
const recipient = await p.generateEncryptionKeypair();
const wrapAad = { sessionId: "s_conf", epoch: 1, deviceId };
const wrapped = await wrapGroupKey(p, { recipientEncPub: recipient.publicKey, groupKey, aadParts: wrapAad });

const frame = { sessionId: "s_conf", epoch: 1, seq: 7, type: "session.entries", plaintext: [{ id: "e1", type: "message" }] };
const frameBox = await sealJson(p, groupKey, frame.plaintext, frameAad({ sessionId: frame.sessionId, epoch: frame.epoch, seq: frame.seq, type: frame.type }));

const command = { sessionId: "s_conf", commandId: "c_1", epoch: 1, op: "prompt", deviceId, args: { text: "hello" } };
const commandBox = await sealJson(p, groupKey, command.args, commandAad({ sessionId: command.sessionId, commandId: command.commandId, epoch: command.epoch, op: command.op, deviceId }));
const commandSignature = await p.sign(
  canonicalJson({ sessionId: command.sessionId, commandId: command.commandId, epoch: command.epoch, op: command.op, deviceId, enc: commandBox }),
  identity.privateKey,
);

const fixture = {
  version: 1,
  note: "PiNet client conformance vectors. Any client implementation must verify/decrypt these.",
  serverId,
  deviceId,
  role,
  identity: { publicKey: identity.publicKey, privateKey: identity.privateKey },
  challenge: { nonce, timestamp, signature },
  groupKey: Buffer.from(groupKey).toString("base64"),
  recipientEncryption: { publicKey: recipient.publicKey, privateKey: recipient.privateKey },
  wrapAad,
  wrapped,
  frame: { ...frame, box: frameBox },
  command: { ...command, box: commandBox, signature: commandSignature },
};

mkdirSync("test/fixtures", { recursive: true });
writeFileSync("test/fixtures/conformance.json", `${JSON.stringify(fixture, null, 2)}\n`);
console.log("wrote test/fixtures/conformance.json");
