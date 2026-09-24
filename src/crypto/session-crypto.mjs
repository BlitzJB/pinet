// Provider-agnostic session crypto: group-key wrapping and frame sealing.
// Given any CryptoProvider, this produces byte-identical results to the Node
// host implementation (src/crypto/e2e.mjs), so clients in any runtime interop.

import { aadFrom } from "../common/canonical.mjs";
import { frameAad, commandAad } from "./aad.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export { frameAad, commandAad };

export async function sealJson(provider, key, value, aad) {
  return provider.encrypt(key, encoder.encode(JSON.stringify(value)), aad);
}

export async function openJson(provider, key, box, aad) {
  return JSON.parse(decoder.decode(await provider.decrypt(key, box, aad)));
}

export async function sealBytes(provider, key, bytes, aad) {
  return provider.encrypt(key, bytes, aad);
}

export async function openBytes(provider, key, box, aad) {
  return provider.decrypt(key, box, aad);
}

export async function wrapGroupKey(provider, { recipientEncPub, groupKey, aadParts }) {
  const ephemeral = await provider.generateEncryptionKeypair();
  const hostEphPub = await provider.exportPublicKey(ephemeral.publicKey);
  const peer = await provider.importPublicKey(recipientEncPub, "encryption");
  const shared = await provider.ecdh(ephemeral.privateKey, peer);
  const aad = aadFrom(aadParts);
  const wrapKey = await provider.hkdf(shared, aad, 32);
  const box = await provider.encrypt(wrapKey, groupKey, aad);
  return { hostEphPub, ...box };
}

export async function unwrapGroupKey(provider, { recipientEncPriv, hostEphPub, wrapped, aadParts }) {
  const peer = await provider.importPublicKey(hostEphPub, "encryption");
  const shared = await provider.ecdh(recipientEncPriv, peer);
  const aad = aadFrom(aadParts);
  const wrapKey = await provider.hkdf(shared, aad, 32);
  return provider.decrypt(wrapKey, wrapped, aad);
}
