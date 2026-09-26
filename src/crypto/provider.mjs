// CryptoProvider: the single abstraction a client must implement to speak the
// PiNet protocol in any runtime.
//
//   generateIdentityKeypair() -> { publicKey, privateKey }   (Ed25519, opaque handles)
//   generateEncryptionKeypair() -> { publicKey, privateKey } (X25519, opaque handles)
//   exportPublicKey(handle) -> base64 DER (spki)
//   importPublicKey(base64Der, kind) -> handle   kind: "identity" | "encryption"
//   importPrivateKey(base64Der, kind) -> handle
//   sign(message, privateKey) -> base64 signature
//   verify(message, signatureBase64, publicKey) -> boolean
//   ecdh(privateKey, publicKeyHandle) -> Uint8Array shared secret
//   hkdf(ikm, info, length) -> Uint8Array         (HKDF-SHA256, empty salt)
//   encrypt(key, plaintext, aad) -> { n, ct, tag } (AES-256-GCM, base64)
//   decrypt(key, box, aad) -> Uint8Array
//   randomBytes(n) -> Uint8Array
//
// The node implementation below is the reference; see webcrypto.mjs for a
// browser-compatible implementation of the same interface.

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

const b64 = (value) => Buffer.from(value).toString("base64");
const publicObj = (value) => createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
const privateObj = (value) => createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });

function exportPair(type) {
  const { publicKey, privateKey } = generateKeyPairSync(type);
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export const nodeCryptoProvider = {
  async generateIdentityKeypair() {
    return exportPair("ed25519");
  },
  async generateEncryptionKeypair() {
    return exportPair("x25519");
  },
  async exportPublicKey(handle) {
    return handle;
  },
  async importPublicKey(base64Der) {
    return base64Der;
  },
  async importPrivateKey(base64Der) {
    return base64Der;
  },
  async sign(message, privateKey) {
    const data = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
    return edSign(null, data, privateObj(privateKey)).toString("base64");
  },
  async verify(message, signature, publicKey) {
    try {
      const data = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
      return edVerify(null, data, publicObj(publicKey), Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  },
  async ecdh(privateKey, publicKeyHandle) {
    return diffieHellman({ privateKey: privateObj(privateKey), publicKey: publicObj(publicKeyHandle) });
  },
  async hkdf(ikm, info, length) {
    return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, length));
  },
  async encrypt(key, plaintext, aad) {
    const iv = nodeRandomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    return { n: b64(iv), ct: b64(ct), tag: b64(cipher.getAuthTag()) };
  },
  async decrypt(key, box, aad) {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.n, "base64"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]);
  },
  randomBytes(n) {
    return nodeRandomBytes(n);
  },
};

export function randomId(provider, bytes = 16) {
  return Array.from(provider.randomBytes(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
