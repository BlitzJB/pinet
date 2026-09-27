export interface DeviceInfo {
  id: string;
  kind: string;
  name: string;
  revoked: boolean;
  fingerprint?: string;
}

export interface Me {
  accountId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  mfaEnrolled: boolean;
  /** Where dictation runs, so the client does not guess. */
  voice?: { enabled: boolean; side: string | null } | null;
  devices: DeviceInfo[];
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

export interface VoiceTake {
  text: string;
  raw?: string;
  flags?: string[];
  durationMs?: number;
  segments?: number;
}

/**
 * Dictation. The audio goes to the hub, which runs speech-to-text and the cleanup
 * pass — the hub holds the provider key, so no host needs one. Nothing is stored
 * there: the caller keeps the take, which is what makes Retry work.
 */
export async function transcribeTake(chunks: string[], sampleRate = 16_000): Promise<VoiceTake> {
  const response = await fetch("/voice/transcribe", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chunks, sampleRate }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `voice ${response.status}`);
  }
  return (await response.json()) as VoiceTake;
}

export async function getMe(): Promise<Me | null> {
  const response = await fetch("/me", { credentials: "include" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`GET /me failed: ${response.status}`);
  return (await response.json()) as Me;
}

export async function registerDevice(body: {
  kind: "controller";
  name: string;
  identityPub: string;
  encPub: string;
}): Promise<{ deviceId: string; fingerprint: string }> {
  const response = await fetch("/devices/register", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`register device failed: ${response.status} ${await readError(response)}`);
  return (await response.json()) as { deviceId: string; fingerprint: string };
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const response = await fetch("/devices", { credentials: "include" });
  if (!response.ok) throw new Error(`GET /devices failed: ${response.status}`);
  return ((await response.json()) as { devices: DeviceInfo[] }).devices;
}

export interface SpawnCapability {
  mode: string;
  cwd: string;
  git: boolean;
  max: number;
  active: number;
  /** True when spawned sessions survive a spawner restart (tmux available). */
  persistent?: boolean;
}

export interface ServerSession {
  sessionId: string;
  hostId: string;
  hostName: string | null;
  hostConnected: boolean;
  meta: { name?: string | null; cwd?: string | null; spawn?: SpawnCapability | null } | null;
  epoch: number;
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await fetch("/devices/revoke", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST", credentials: "include" });
}

export function loginUrl(returnTo = "/app/"): string {
  return `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}
