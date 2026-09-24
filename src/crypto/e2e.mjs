// End-to-end encryption.
//
// A host generates a random 32-byte group key per session epoch and wraps it
// for each authorized controller using ephemeral-static X25519 + HKDF-SHA256.
// Session frames and command arguments are sealed with AES-256-GCM and bound
// to routing metadata via AAD, so the coordinator can relay and cache but never
// read or tamper undetected.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { aadFrom } from "../common/canonical.mjs";
import { commandAad, frameAad } from "./aad.mjs";
import { ecdh, generateX25519 } from "./keys.mjs";

export { commandAad, frameAad };

const KEY_BYTES = 32;
const IV_BYTES = 12;

export function generateGroupKey() {
  return randomBytes(KEY_BYTES);
}

export function seal(key, plaintext, aad) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return { n: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function open(key, box, aad) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.n, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]);
}

export function sealJson(key, value, aad) {
  return seal(key, Buffer.from(JSON.stringify(value), "utf8"), aad);
}

export function openJson(key, box, aad) {
  return JSON.parse(open(key, box, aad).toString("utf8"));
}

function wrapKeyFor(sharedSecret, aad) {
  return Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.alloc(0), aad, KEY_BYTES));
}

/** Host side: wrap the group key for one controller. */
export function wrapGroupKey({ recipientEncPub, groupKey, aadParts }) {
  const eph = generateX25519();
  const aad = aadFrom(aadParts);
  const shared = ecdh(eph.privateKey, recipientEncPub);
  const wrapKey = wrapKeyFor(shared, aad);
  const box = seal(wrapKey, groupKey, aad);
  return { hostEphPub: eph.publicKey, ...box };
}

/** Controller side: unwrap the group key sent by the host. */
export function unwrapGroupKey({ recipientEncPriv, hostEphPub, wrapped, aadParts }) {
  const aad = aadFrom(aadParts);
  const shared = ecdh(recipientEncPriv, hostEphPub);
  const wrapKey = wrapKeyFor(shared, aad);
  return open(wrapKey, wrapped, aad);
}

export const E2E = { KEY_BYTES, IV_BYTES };
