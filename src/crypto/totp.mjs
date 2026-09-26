// RFC 6238 TOTP + base32 + recovery codes. Implemented with node:crypto so the
// authenticator-app factor works with standard apps (Google Authenticator,
// Aegis, 1Password, ...).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "../common/ids.mjs";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input) {
  const clean = input.replace(/=+$/u, "").toUpperCase().replace(/\s+/gu, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

export function hotp(secret, counter, { digits = 6, algorithm = "sha1" } = {}) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(secret, { time = Date.now(), step = 30, digits = 6, algorithm = "sha1" } = {}) {
  const key = typeof secret === "string" ? base32Decode(secret) : secret;
  return hotp(key, Math.floor(time / 1000 / step), { digits, algorithm });
}

/**
 * Verify a TOTP code within a +/- window. `lastCounter` prevents replay:
 * a counter <= lastCounter is rejected, even if the code is otherwise valid.
 */
export function verifyTotp(secret, code, { time = Date.now(), step = 30, digits = 6, window = 1, algorithm = "sha1", lastCounter = -1 } = {}) {
  if (typeof code !== "string" || !new RegExp(`^\\d{${digits}}$`, "u").test(code)) {
    return { ok: false, counter: -1 };
  }
  const key = typeof secret === "string" ? base32Decode(secret) : secret;
  const counter = Math.floor(time / 1000 / step);
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = counter + delta;
    if (candidate <= lastCounter) continue;
    const expected = hotp(key, candidate, { digits, algorithm });
    if (timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(code, "utf8"))) {
      return { ok: true, counter: candidate };
    }
  }
  return { ok: false, counter: -1 };
}

export function otpauthUri({ secret, account, issuer = "PiNet", digits = 6, period = 30, algorithm = "SHA1" }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm, digits: String(digits), period: String(period) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}

export function hashRecoveryCode(code) {
  return sha256Hex(code.trim().toUpperCase());
}

export function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
