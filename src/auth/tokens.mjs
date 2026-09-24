// Compact HMAC-signed tokens used for web sessions and pending-MFA state.

import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../common/canonical.mjs";

const b64url = (value) => Buffer.from(value).toString("base64url");

export function issueToken({ payload, secret, ttlMs = 3_600_000, now = Date.now() }) {
  const body = { ...payload, iat: now, exp: now + ttlMs };
  const encoded = b64url(canonicalJson(body));
  const sig = b64url(createHmac("sha256", secret).update(encoded).digest());
  return `${encoded}.${sig}`;
}

export function verifyToken(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let given;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  return payload;
}
