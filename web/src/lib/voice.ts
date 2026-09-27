// Microphone capture for dictation.
//
// Speech becomes 16 kHz mono PCM16, delivered as base64 chunks every ~250ms.
// pinet seals each chunk before it leaves the browser, so audio is ciphertext
// end to end — the coordinator relays it without ever being able to read it, and
// the host holds it in memory only.
//
// Capture lives in an AudioWorklet: 128-sample render quanta are batched to
// ~250ms for the audio, and level samples are posted ~20x/second for the
// waveform. A linear resampler carries its position across chunks so no sample is
// dropped at a boundary.

/** Sample rate the STT provider expects. */
const TARGET_RATE = 16_000;
/**
 * The worklet is a real same-origin file (`web/public/voice-worklet.js`), not a
 * Blob URL. The app sends `worker-src 'self'`, which blocks blob: worklets — and
 * that failure was silent, leaving the mic button doing nothing at all. Resolved
 * against the app base so it works from any route (`/app/s/<id>`).
 */
const WORKLET_URL = `${import.meta.env.BASE_URL}voice-worklet.js`;
/**
 * How many level samples to keep. Comfortably more than the waveform shows
 * (columns x samplesPerColumn), since each column aggregates a slice.
 */
export const WAVEFORM_PEAKS = 512;

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

/** A capture failure, carried as the one line the user needs to read. */
export class MicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicError";
  }
}

const isPermissionError = (error: unknown): boolean => {
  const name = (error as { name?: string })?.name;
  return name === "NotAllowedError" || name === "SecurityError";
};

/** The user-facing reason, in one line. */
export function micErrorMessage(error: unknown): string {
  const name = (error as { name?: string })?.name ?? "Error";
  if (isPermissionError(error)) return "Microphone blocked — allow it for this site";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No microphone found";
  if (name === "NotReadableError" || name === "TrackStartError") return "Microphone in use by another app";
  if (name === "OverconstrainedError") return "This microphone can't satisfy the requested settings";
  return "Could not start recording";
}

/**
 * Rolling level history for the waveform: append and keep the newest `max`.
 * Pure so the shape of the history is testable without an audio device.
 */
export function appendPeaks(existing: number[], incoming: number[], max = WAVEFORM_PEAKS): number[] {
  const next = incoming.length >= max ? incoming.slice(incoming.length - max) : [...existing, ...incoming];
  return next.length > max ? next.slice(next.length - max) : next;
}

export interface VoiceRecorder {
  /** Total audio captured so far, for the UI timer. */
  readonly bytes: number;
  stop(): Promise<void>;
}

export interface RecorderOptions {
  onChunk: (chunkBase64: string, index: number) => void;
  /** Level samples, 0..1, 20 per second (aggregated into columns for display). */
  onPeaks?: (peaks: number[]) => void;
  onError?: (message: string) => void;
}

export function voiceSupported(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
  if (typeof AudioContext === "undefined") return false;
  // The type always declares `audioWorklet`, but older Safari does not have it.
  return "audioWorklet" in AudioContext.prototype;
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

export async function startVoiceRecorder({ onChunk, onPeaks, onError }: RecorderOptions): Promise<VoiceRecorder> {
  if (!voiceSupported()) throw new MicError("This browser cannot capture audio");

  let stream: MediaStream;
  try {
    stream = await openInputStream();
  } catch (error) {
    throw new MicError(micErrorMessage(error));
  }

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  try {
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch {
    for (const track of stream.getTracks()) track.stop();
    await context.close().catch(() => undefined);
    throw new MicError("The audio capture module was blocked");
  }

  const node = new AudioWorkletNode(context, "pinet-capture");
  // Not connected to the destination: monitoring the mic into the speakers would
  // feed back.
  source.connect(node);

  const resampler = new Resampler();
  let index = 0;
  let bytes = 0;
  let closed = false;

  node.port.onmessage = (event: MessageEvent<{ audio?: Float32Array; peaks?: number[] }>) => {
    if (closed) return;
    const message = event.data;
    if (message.peaks?.length) onPeaks?.(message.peaks);
    const frame = message.audio;
    if (!frame) return;
    const pcm = resampler.process(frame, context.sampleRate);
    if (!pcm.length) return;
    bytes += pcm.byteLength;
    try {
      onChunk(toBase64(pcm), index);
      index += 1;
    } catch (error) {
      onError?.(String((error as Error)?.message ?? error));
    }
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
