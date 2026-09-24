import { randomUUID, randomBytes, createHash } from "node:crypto";

export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function newSessionId() {
  return randomUUID();
}

export function newNonce() {
  return randomBytes(24).toString("base64url");
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function shortFingerprint(value) {
  return sha256Hex(value).slice(0, 16);
}
