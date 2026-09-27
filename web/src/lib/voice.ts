// Microphone capture for dictation.
//
// Speech becomes 16 kHz mono PCM16, delivered as base64 chunks every ~250ms.
// pinet seals each chunk before it leaves the browser, so audio is ciphertext
// end to end — the coordinator relays it without ever being able to read it, and
// the host holds it in memory only.
//
// Capture lives in an AudioWorklet (128-sample frames, batched to ~250ms so we
// aren't posting ~370 messages a second), with a small linear resampler carrying
// its position across chunks so no sample is dropped at a boundary.

/** Sample rate the STT provider expects. */
const TARGET_RATE = 16_000;
/**
 * The worklet is a real same-origin file (`web/public/voice-worklet.js`), not a
 * Blob URL. The app sends `worker-src 'self'`, which blocks blob: worklets — and
 * that failure was silent, leaving the mic button doing nothing at all. Resolved
 * against the app base so it works from any route (`/app/s/<id>`).
 */
const WORKLET_URL = `${import.meta.env.BASE_URL}voice-worklet.js`;

/** Integer/linear downmix to 16 kHz, keeping phase across chunk boundaries. */
class Resampler {
  private position = 0;

  process(input: Float32Array, inputRate: number): Int16Array {
    if (inputRate === TARGET_RATE) {
      const direct = new Int16Array(input.length);
      for (let i = 0; i < input.length; i += 1) direct[i] = Math.max(-1, Math.min(1, input[i])) * 32767;
      return direct;
    }
    const step = inputRate / TARGET_RATE;
    const out: number[] = [];
    while (this.position < input.length - 1) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const sample = input[index] * (1 - fraction) + input[index + 1] * fraction;
      out.push(Math.max(-1, Math.min(1, sample)) * 32767);
      this.position += step;
    }
    this.position -= input.length;
    return Int16Array.from(out);
  }
}

function toBase64(bytes: Int16Array): string {
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = "";
  // Chunked so a large utterance cannot blow the argument limit.
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export interface VoiceRecorder {
  /** Total audio captured so far, for the UI timer. */
  readonly bytes: number;
  stop(): Promise<void>;
}

/** A capture failure with enough context to tell the user what to do about it. */
export class MicError extends Error {
  readonly info: MicErrorInfo;

  constructor(info: MicErrorInfo) {
    super(info.message);
    this.name = "MicError";
    this.info = info;
  }
}

export interface MicErrorInfo {
  /** What went wrong, in one line. */
  message: string;
  /** What the user can do about it. */
  hint: string;
  /** Raw detail (error name, permission state, secure context) for a tooltip. */
  detail: string;
}

const isPermissionError = (error: unknown): boolean => {
  const name = (error as { name?: string })?.name;
  return name === "NotAllowedError" || name === "SecurityError";
};

function refusedBeforePromptSteps(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const steps = [];
  if (/Macintosh/i.test(ua)) {
    steps.push(
      "macOS: System Settings → Privacy & Security → Microphone → turn on your browser (and the installed app, if it is listed separately), then quit the browser completely (\u2318Q, not just the window) and reopen it — a reload keeps the old state.",
    );
    steps.push("If that switch is greyed out or says your administrator controls it, a management profile is blocking it and no local setting can override it.");
  } else if (/Android/i.test(ua)) {
    steps.push("Android: Settings → Apps → Chrome → Permissions → Microphone → Allow, then reopen Chrome.");
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    steps.push("iOS: Settings → Safari → Microphone → Allow.");
  } else {
    steps.push("Operating system: grant your browser microphone access in the system privacy settings, then fully quit and reopen it.");
  }
  steps.push("Cross-check with a different browser: each app has its own microphone permission, so if another one prompts and works, the first browser is the one being refused.");
  return steps.join(" ");
}

/**
 * How to unblock a microphone the browser has recorded as denied. `denied` (as
 * opposed to `prompt`) means a decision is stored against this origin, so
 * reloading cannot clear it — the site setting has to be changed. The steps are
 * platform-specific because the setting lives in a different place on each.
 */
function unblockSteps(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const steps = [
    "Click the icon at the left of the address bar → Microphone → Allow, then reload.",
    "If the site is listed under Blocked in chrome://settings/content/microphone, move it to Allowed.",
  ];
  if (/Android/i.test(ua)) {
    steps.splice(0, 0, "Android: Settings → Apps → Chrome → Permissions → Microphone → Allow.");
  }
  if (/iPhone|iPad|iPod/i.test(ua)) {
    steps.splice(0, 0, "iOS: Settings → Safari → Microphone → Allow (and the per-site menu via the \"aA\" button).");
  }
  if (/Macintosh|Windows|Linux/i.test(ua)) {
    steps.push("On a managed/work machine, open chrome://policy — a microphone policy cannot be overridden from the UI.");
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)")?.matches) {
    steps.push("You are in the installed app window: open the same URL in a normal browser tab to change the site permission, then come back.");
  }
  steps.push("To isolate a stored block from an OS or policy block: open the same URL in a private/incognito window. It starts from a fresh permission state.");
  return steps.join(" ");
}

/** The browser's remembered decision, when it will tell us. */
export async function micPermissionState(): Promise<PermissionState | "unknown"> {
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {
    return "unknown";
  }
}

export async function micDevices(): Promise<string[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput").map((device) => device.label || "(unlabelled until granted)");
  } catch {
    return [];
  }
}

/**
 * Everything needed to diagnose a capture failure from a bug report, without a
 * round of guesswork. `AudioWorklet` presence is reported because a missing or
 * blocked worklet fails *silently* by nature.
 */
export async function captureDiagnostics(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    workletUrl: WORKLET_URL,
    audioWorkletSupported: typeof AudioContext === "undefined" ? false : "audioWorklet" in AudioContext.prototype,
    mediaDevices: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices),
    permissionsApi: typeof navigator !== "undefined" && typeof navigator.permissions?.query === "function",
    documentAllowsMicrophone: (() => {
      // The applied document policy. A `Permissions-Policy: microphone=()` header
      // makes this false — and that looks exactly like a user or OS block, so it
      // is worth reporting separately.
      if (typeof document === "undefined") return "unknown";
      const policy = (document as unknown as { permissionsPolicy?: { allowsFeature?: (feature: string) => boolean } }).permissionsPolicy;
      try {
        return policy?.allowsFeature ? policy.allowsFeature("microphone") : "unknown";
      } catch {
        return "unknown";
      }
    })(),
    permission: await micPermissionState(),
    secureContext: typeof isSecureContext === "boolean" ? isSecureContext : "unknown",
    inputs: await micDevices(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    ...extra,
  };
}

/**
 * A denied microphone has three quite different causes, and they need different
 * fixes, so this separates them instead of reporting "permission denied" for all
 * of them:
 *
 *   1. the browser remembers a block for this origin (permission === "denied")
 *   2. the site is allowed but the *OS* is blocking the browser/app
 *   3. the device is missing, busy, or cannot satisfy the constraints
 */
export function micErrorInfo(error: unknown, permission: PermissionState | "unknown" = "unknown", elapsedMs?: number): MicErrorInfo {
  const name = (error as { name?: string })?.name ?? "Error";
  const secure = typeof isSecureContext === "boolean" ? String(isSecureContext) : "unknown";
  const detail = `${name}: ${(error as { message?: string })?.message ?? ""} (permission=${permission}, secureContext=${secure})`;

  if (isPermissionError(error)) {
    if (permission === "denied") {
      return {
        message: "The browser has blocked the microphone for this site",
        hint: unblockSteps(),
        detail,
      };
    }
    // Site permission is still "ask"/unknown, yet the call was refused — and
    // refused *instantly*, without a prompt ever appearing. That means the
    // refusal happened before the browser could ask, i.e. at the app/OS level:
    // Chrome has no microphone access of its own, so no site setting can help.
    // (A site-level block would read "denied" above; a prompt would have taken
    // seconds and returned an answer.)
    const instant = typeof elapsedMs === "number" && elapsedMs < 250;
    if (instant) {
      return {
        message: "Your system is blocking the browser's microphone",
        hint: `${refusedBeforePromptSteps()}`,
        detail: `${detail} rejectedAfterMs=${Math.round(elapsedMs ?? -1)} (no prompt was shown)`,
      };
    }
    return {
      message: "Something outside the page is blocking the microphone",
      hint: "The site is allowed, so the operating system is refusing it: enable your browser (or this installed app) in System Settings → Privacy & Security → Microphone, then quit and reopen it. On iOS: Settings → Safari → Microphone.",
      detail,
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return { message: "No microphone found", hint: "Connect an input device and reload.", detail };
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return { message: "The microphone is in use by another app", hint: "Close whatever else is recording and try again.", detail };
  }
  if (name === "OverconstrainedError") {
    return { message: "This microphone does not support the requested settings", hint: "Try again — the recorder falls back to the loosest possible request.", detail };
  }
  return { message: "Could not start recording", hint: "Reload the page and try again.", detail };
}

/**
 * Open the input stream.
 *
 * Every constraint is an `ideal`, never an exact, value: a bare value in a
 * MediaTrackConstraints dictionary means `exact`, so `channelCount: 1` makes a
 * stereo-only input fail outright. If the preferred set still fails — and not
 * because of a permission decision — fall back to the loosest possible request
 * before giving up, since capture only ever reads the first channel anyway.
 */
async function openInputStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
      },
    });
  } catch (error) {
    if (isPermissionError(error)) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

export interface RecorderOptions {
  onChunk: (chunkBase64: string, index: number) => void;
  onError?: (message: string) => void;
  /** Peak level 0..1 per chunk, for a level meter. */
  onLevel?: (level: number) => void;
}

export function voiceSupported(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
  if (typeof AudioContext === "undefined") return false;
  // The type always declares `audioWorklet`, but older Safari does not have it.
  return "audioWorklet" in AudioContext.prototype;
}

export async function startVoiceRecorder({ onChunk, onError, onLevel }: RecorderOptions): Promise<VoiceRecorder> {
  if (!voiceSupported()) throw new Error("This browser cannot capture audio (AudioWorklet unavailable)");

  let stream: MediaStream;
  const startedAt = Date.now();
  try {
    stream = await openInputStream();
  } catch (error) {
    throw new MicError(micErrorInfo(error, await micPermissionState(), Date.now() - startedAt));
  }

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  try {
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    await context.close().catch(() => undefined);
    throw new MicError({
      message: "The audio capture module was blocked",
      hint: `The browser refused to load ${WORKLET_URL}. If you are offline, reload; otherwise this is a content-security-policy or caching problem and the console will name it.`,
      detail: `addModule(${WORKLET_URL}) failed: ${(error as { name?: string })?.name ?? "Error"}: ${(error as { message?: string })?.message ?? ""}`,
    });
  }

  const node = new AudioWorkletNode(context, "pinet-capture");
  // Not connected to the destination: monitoring the mic back into the speakers
  // would feed back.
  source.connect(node);

  const resampler = new Resampler();
  let index = 0;
  let bytes = 0;
  let closed = false;

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (closed) return;
    const frame = event.data;
    let peak = 0;
    for (let i = 0; i < frame.length; i += 1) {
      const magnitude = Math.abs(frame[i]);
      if (magnitude > peak) peak = magnitude;
    }
    const pcm = resampler.process(frame, context.sampleRate);
    if (!pcm.length) return;
    bytes += pcm.byteLength;
    try {
      onChunk(toBase64(pcm), index);
      index += 1;
    } catch (error) {
      onError?.(String((error as Error)?.message ?? error));
      return;
    }
    onLevel?.(Math.min(1, peak));
  };

  return {
    get bytes() {
      return bytes;
    },
    async stop() {
      if (closed) return;
      closed = true;
      node.port.onmessage = null;
      try {
        source.disconnect();
        node.disconnect();
      } catch {
        /* already torn down */
      }
      for (const track of stream.getTracks()) track.stop();
      await context.close().catch(() => undefined);
    },
  };
}
