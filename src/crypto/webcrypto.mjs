// WebCrypto CryptoProvider: the same interface as nodeCryptoProvider, built on
// globalThis.crypto.subtle so it runs unchanged in browsers, Deno, Bun and
// Node 22+. A client that uses this provider has no Node dependencies.

import { fromBase64, toBase64 } from "../common/base64.mjs";

const subtle = globalThis.crypto?.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requireSubtle() {
  if (!subtle) throw new Error("WebCrypto (globalThis.crypto.subtle) is not available in this runtime");
}

function algorithmFor(kind, usages) {
  if (kind === "identity") return { name: "Ed25519" };
  if (kind === "encryption") return { name: "X25519" };
  throw new Error(`unknown key kind: ${kind}`);
}

export const webCryptoProvider = {
  async generateIdentityKeypair() {
    requireSubtle();
    const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    return { publicKey: pair.publicKey, privateKey: pair.privateKey };
  },

  async generateEncryptionKeypair() {
    requireSubtle();
    const pair = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    return { publicKey: pair.publicKey, privateKey: pair.privateKey };
  },

  async exportPublicKey(handle) {
    requireSubtle();
    return toBase64(new Uint8Array(await subtle.exportKey("spki", handle)));
  },

  async importPublicKey(base64Der, kind) {
    requireSubtle();
    const usages = kind === "identity" ? ["verify"] : [];
    return subtle.importKey("spki", fromBase64(base64Der), algorithmFor(kind), true, usages);
  },

  async importPrivateKey(base64Der, kind) {
    requireSubtle();
    const usages = kind === "identity" ? ["sign"] : ["deriveBits"];
    return subtle.importKey("pkcs8", fromBase64(base64Der), algorithmFor(kind), true, usages);
  },

  async sign(message, privateKey) {
    requireSubtle();
    const data = typeof message === "string" ? encoder.encode(message) : message;
    const signature = await subtle.sign("Ed25519", privateKey, data);
    return toBase64(new Uint8Array(signature));
  },

  async verify(message, signature, publicKey) {
    requireSubtle();
    try {
      const data = typeof message === "string" ? encoder.encode(message) : message;
      return await subtle.verify("Ed25519", publicKey, fromBase64(signature), data);
    } catch {
      return false;
    }
  },

  async ecdh(privateKey, publicKeyHandle) {
    requireSubtle();
    const bits = await subtle.deriveBits({ name: "X25519", public: publicKeyHandle }, privateKey, 256);
    return new Uint8Array(bits);
  },

  async hkdf(ikm, info, length) {
    requireSubtle();
    const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, base, length * 8);
    return new Uint8Array(bits);
  },

  async encrypt(key, plaintext, aad) {
    requireSubtle();
    const iv = this.randomBytes(12);
    const cryptoKey = await subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
    const data = typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext;
    const result = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, cryptoKey, data));
    const ct = result.slice(0, result.length - 16);
    const tag = result.slice(result.length - 16);
    return { n: toBase64(iv), ct: toBase64(ct), tag: toBase64(tag) };
  },

  async decrypt(key, box, aad) {
    requireSubtle();
    const cryptoKey = await subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
    const ct = fromBase64(box.ct);
    const tag = fromBase64(box.tag);
    const combined = new Uint8Array(ct.length + tag.length);
    combined.set(ct, 0);
    combined.set(tag, ct.length);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: fromBase64(box.n), additionalData: aad, tagLength: 128 }, cryptoKey, combined);
    return new Uint8Array(plain);
  },

  randomBytes(n) {
    requireSubtle();
    return globalThis.crypto.getRandomValues(new Uint8Array(n));
  },
};

export { decoder as webCryptoDecoder, encoder as webCryptoEncoder };
