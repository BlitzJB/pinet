// Ed25519 (identity/signing) and X25519 (key agreement) helpers.
// Keys are exchanged as base64 DER so they survive JSON round-trips.

import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";

function exportKeyPair(type) {
  const { publicKey, privateKey } = generateKeyPairSync(type);
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export const generateEd25519 = () => exportKeyPair("ed25519");
export const generateX25519 = () => exportKeyPair("x25519");

const publicObj = (b64) => createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
const privateObj = (b64) => createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });

export function sign(message, privateKeyB64) {
  const data = typeof message === "string" ? Buffer.from(message, "utf8") : message;
  return edSign(null, data, privateObj(privateKeyB64)).toString("base64");
}

export function verify(message, signatureB64, publicKeyB64) {
  const data = typeof message === "string" ? Buffer.from(message, "utf8") : message;
  try {
    return edVerify(null, data, publicObj(publicKeyB64), Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export function ecdh(privateKeyB64, publicKeyB64) {
  return diffieHellman({ privateKey: privateObj(privateKeyB64), publicKey: publicObj(publicKeyB64) });
}

export function fingerprint(publicKeyB64) {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex");
}
