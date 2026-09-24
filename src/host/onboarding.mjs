// Device onboarding, independent of pi's UI so it can be unit/integration
// tested. Used for both hosts and controllers (portals).
//
// Primary flow: RFC 8628-style device authorization. The user is shown a code
// and URL, completes Google SSO + MFA in a browser, approves, and the device is
// enrolled and connected -- all without leaving pi.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateEd25519, generateX25519 } from "../crypto/keys.mjs";

function loadState(dir, file) {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch {
    return {};
  }
}

function saveState(dir, file, patch) {
  const path = join(dir, file);
  const next = { ...loadState(dir, file), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

function clearState(dir, file) {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n", { mode: 0o600 });
}

function ensureKeys(dir, file) {
  const state = loadState(dir, file);
  if (state.identity && state.encryption) return { identity: state.identity, encryption: state.encryption };
  const identity = generateEd25519();
  const encryption = generateX25519();
  saveState(dir, file, { identity, encryption });
  return { identity, encryption };
}

// -- host wrappers (backwards compatible) -----------------------------------

export const statePath = (dir) => join(dir, "host.json");
export const loadHostState = (dir) => loadState(dir, "host.json");
export const saveHostState = (dir, patch) => saveState(dir, "host.json", patch);
export const clearHostState = (dir) => clearState(dir, "host.json");
export const ensureHostKeys = (dir) => ensureKeys(dir, "host.json");

// -- controller wrappers ----------------------------------------------------

export const controllerStatePath = (dir) => join(dir, "controller.json");
export const loadControllerState = (dir) => loadState(dir, "controller.json");
export const saveControllerState = (dir, patch) => saveState(dir, "controller.json", patch);
export const clearControllerState = (dir) => clearState(dir, "controller.json");
export const ensureControllerKeys = (dir) => ensureKeys(dir, "controller.json");

// -- device authorization ---------------------------------------------------

async function postJson(fetchImpl, url, body, token) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${data.error ?? ""}`.trim());
  return data;
}

export async function startDeviceFlow({ httpUrl, fetchImpl = fetch }) {
  return postJson(fetchImpl, `${httpUrl}/auth/device/start`, {});
}

export async function pollDeviceFlow({ httpUrl, deviceCode, fetchImpl = fetch, signal, intervalMs, maxMs = 10 * 60_000, onTick }) {
  const started = Date.now();
  const wait = intervalMs ?? 3000;
  for (;;) {
    if (signal?.aborted) throw new Error("cancelled");
    const data = await postJson(fetchImpl, `${httpUrl}/auth/device/poll`, { deviceCode });
    if (data.status === "approved" && data.sessionToken) return { sessionToken: data.sessionToken };
    if (data.status === "expired" || data.status === "invalid") throw new Error(`device code ${data.status}`);
    if (Date.now() - started > maxMs) throw new Error("device code timed out");
    onTick?.(data.status);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export async function registerDevice({ httpUrl, sessionToken, kind, name, identity, encryption, fetchImpl = fetch }) {
  const data = await postJson(
    fetchImpl,
    `${httpUrl}/devices/register`,
    { kind, name, identityPub: identity.publicKey, encPub: encryption.publicKey },
    sessionToken,
  );
  return { deviceId: data.deviceId, fingerprint: data.fingerprint };
}

export const registerHost = (options) => registerDevice({ ...options, kind: "host" });
export const registerController = (options) => registerDevice({ ...options, kind: "controller" });

export async function enrollHostWithCode({ httpUrl, code, name, identity, encryption, fetchImpl = fetch }) {
  const data = await postJson(fetchImpl, `${httpUrl}/hosts/enroll`, {
    code,
    name,
    identityPub: identity.publicKey,
    encPub: encryption.publicKey,
  });
  return { hostId: data.hostId, fingerprint: data.fingerprint };
}

async function onboardDevice({ kind, file, httpUrl, dir, name, fetchImpl = fetch, signal, onCode, onTick }) {
  const { identity, encryption } = ensureKeys(dir, file);
  const flow = await startDeviceFlow({ httpUrl, fetchImpl });
  onCode?.({ userCode: flow.userCode, verificationUri: flow.verificationUri, expiresIn: flow.expiresIn });
  const { sessionToken } = await pollDeviceFlow({
    httpUrl,
    deviceCode: flow.deviceCode,
    fetchImpl,
    signal,
    intervalMs: (flow.interval ?? 3) * 1000,
    onTick,
  });
  const { deviceId, fingerprint } = await registerDevice({ httpUrl, sessionToken, kind, name, identity, encryption, fetchImpl });
  saveState(dir, file, { hostId: deviceId, deviceId, fingerprint, identity, encryption });
  return { hostId: deviceId, deviceId, fingerprint, identity, encryption };
}

/** Full in-pi host onboarding. */
export const onboardHost = (options) => onboardDevice({ ...options, kind: "host", file: "host.json" });

/** Full in-pi controller (portal) onboarding. */
export const onboardController = (options) => onboardDevice({ ...options, kind: "controller", file: "controller.json" });
