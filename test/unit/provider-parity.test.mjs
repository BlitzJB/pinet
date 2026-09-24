import { describe, expect, it } from "vitest";
import { nodeCryptoProvider } from "../../src/crypto/provider.mjs";
import { webCryptoProvider } from "../../src/crypto/webcrypto.mjs";
import { openJson, sealJson, unwrapGroupKey, wrapGroupKey } from "../../src/crypto/session-crypto.mjs";

const node = nodeCryptoProvider;
const web = webCryptoProvider;

describe("provider parity: identity", () => {
  it("verifies a node signature with webcrypto and vice versa", async () => {
    const nodeKeys = await node.generateIdentityKeypair();
    const message = "canonical-json-payload";
    const nodeSig = await node.sign(message, nodeKeys.privateKey);

    const webPub = await web.importPublicKey(nodeKeys.publicKey, "identity");
    expect(await web.verify(message, nodeSig, webPub)).toBe(true);

    const webKeys = await web.generateIdentityKeypair();
    const webPubB64 = await web.exportPublicKey(webKeys.publicKey);
    const webSig = await web.sign(message, webKeys.privateKey);
    expect(await node.verify(message, webSig, webPubB64)).toBe(true);
    expect(await node.verify("tampered", webSig, webPubB64)).toBe(false);
  });
});

describe("provider parity: key agreement + hkdf", () => {
  it("derives the same shared secret", async () => {
    const a = await node.generateEncryptionKeypair();
    const b = await web.generateEncryptionKeypair();
    const bPub = await web.exportPublicKey(b.publicKey);

    const nodeShared = await node.ecdh(a.privateKey, bPub);
    const aPub = await node.exportPublicKey(a.publicKey);
    const webShared = await web.ecdh(b.privateKey, await web.importPublicKey(aPub, "encryption"));

    expect(Buffer.from(nodeShared).toString("base64")).toBe(Buffer.from(webShared).toString("base64"));

    const info = new TextEncoder().encode("info");
    const nodeKey = await node.hkdf(nodeShared, info, 32);
    const webKey = await web.hkdf(webShared, info, 32);
    expect(Buffer.from(nodeKey).toString("base64")).toBe(Buffer.from(webKey).toString("base64"));
  });
});

describe("provider parity: aead", () => {
  it("cross-decrypts in both directions", async () => {
    const key = node.randomBytes(32);
    const aad = new TextEncoder().encode("aad");
    const value = { hello: "world" };

    const nodeBox = await sealJson(node, key, value, aad);
    expect(await openJson(web, key, nodeBox, aad)).toEqual(value);

    const webBox = await sealJson(web, key, value, aad);
    expect(await openJson(node, key, webBox, aad)).toEqual(value);
  });
});

describe("session crypto format equivalence", () => {
  it("a webcrypto-wrapped key unwraps with the node path, and vice versa", async () => {
    const groupKey = node.randomBytes(32);
    const recipient = await node.generateEncryptionKeypair();
    const aadParts = { sessionId: "s_eq", epoch: 2, deviceId: "d_eq" };

    const wrappedByWeb = await wrapGroupKey(web, { recipientEncPub: recipient.publicKey, groupKey, aadParts });
    const unwrappedByNode = await unwrapGroupKey(node, {
      recipientEncPriv: recipient.privateKey,
      hostEphPub: wrappedByWeb.hostEphPub,
      wrapped: wrappedByWeb,
      aadParts,
    });
    expect(Buffer.from(unwrappedByNode).toString("base64")).toBe(Buffer.from(groupKey).toString("base64"));

    const wrappedByNode = await wrapGroupKey(node, { recipientEncPub: recipient.publicKey, groupKey, aadParts });
    const unwrappedByWeb = await unwrapGroupKey(web, {
      recipientEncPriv: await web.importPrivateKey(recipient.privateKey, "encryption"),
      hostEphPub: wrappedByNode.hostEphPub,
      wrapped: wrappedByNode,
      aadParts,
    });
    expect(Buffer.from(unwrappedByWeb).toString("base64")).toBe(Buffer.from(groupKey).toString("base64"));
  });
});
