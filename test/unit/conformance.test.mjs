import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/common/canonical.mjs";
import { commandAad, frameAad } from "../../src/crypto/aad.mjs";
import { nodeCryptoProvider } from "../../src/crypto/provider.mjs";
import { openJson, unwrapGroupKey } from "../../src/crypto/session-crypto.mjs";
import { webCryptoProvider } from "../../src/crypto/webcrypto.mjs";

const fixturePath = new URL("../fixtures/conformance.json", import.meta.url);
const hasFixture = existsSync(fixturePath);
const fixture = hasFixture ? JSON.parse(readFileSync(fixturePath, "utf8")) : undefined;

// The same fixture must validate under both providers. This is the contract an
// external client (web app, mobile, other language) implements against.
for (const [name, provider] of [
  ["node", nodeCryptoProvider],
  ["webcrypto", webCryptoProvider],
]) {
  describe(`conformance vectors (${name} provider)`, () => {
    it.skipIf(!hasFixture)("verifies the challenge signature", async () => {
      const payload = canonicalJson({
        nonce: fixture.challenge.nonce,
        serverId: fixture.serverId,
        timestamp: fixture.challenge.timestamp,
        role: fixture.role,
        deviceId: fixture.deviceId,
      });
      const publicKey = await provider.importPublicKey(fixture.identity.publicKey, "identity");
      expect(await provider.verify(payload, fixture.challenge.signature, publicKey)).toBe(true);
    });

    it.skipIf(!hasFixture)("unwraps the session group key", async () => {
      const privateKey = await provider.importPrivateKey(fixture.recipientEncryption.privateKey, "encryption");
      const groupKey = await unwrapGroupKey(provider, {
        recipientEncPriv: privateKey,
        hostEphPub: fixture.wrapped.hostEphPub,
        wrapped: fixture.wrapped,
        aadParts: fixture.wrapAad,
      });
      expect(Buffer.from(groupKey).toString("base64")).toBe(fixture.groupKey);
    });

    it.skipIf(!hasFixture)("decrypts a session frame", async () => {
      const groupKey = Buffer.from(fixture.groupKey, "base64");
      const plaintext = await openJson(
        provider,
        groupKey,
        fixture.frame.box,
        frameAad({ sessionId: fixture.frame.sessionId, epoch: fixture.frame.epoch, seq: fixture.frame.seq, type: fixture.frame.type }),
      );
      expect(plaintext).toEqual(fixture.frame.plaintext);
    });

    it.skipIf(!hasFixture)("verifies and decrypts a command", async () => {
      const publicKey = await provider.importPublicKey(fixture.identity.publicKey, "identity");
      const signed = canonicalJson({
        sessionId: fixture.command.sessionId,
        commandId: fixture.command.commandId,
        epoch: fixture.command.epoch,
        op: fixture.command.op,
        deviceId: fixture.command.deviceId,
        enc: fixture.command.box,
      });
      expect(await provider.verify(signed, fixture.command.signature, publicKey)).toBe(true);
      const groupKey = Buffer.from(fixture.groupKey, "base64");
      const args = await openJson(
        provider,
        groupKey,
        fixture.command.box,
        commandAad({
          sessionId: fixture.command.sessionId,
          commandId: fixture.command.commandId,
          epoch: fixture.command.epoch,
          op: fixture.command.op,
          deviceId: fixture.command.deviceId,
        }),
      );
      expect(args).toEqual(fixture.command.args);
    });
  });
}
