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
/** How much audio to batch before handing a chunk to the caller. */
const CHUNK_MS = 250;

const WORKLET_SOURCE = `
class PinetCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.total = 0;
    this.want = Math.round(sampleRate * ${CHUNK_MS} / 1000);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.parts.push(channel.slice(0));
      this.total += channel.length;
      if (this.total >= this.want) {
        const merged = new Float32Array(this.total);
        let offset = 0;
        for (const part of this.parts) { merged.set(part, offset); offset += part.length; }
        this.parts = [];
        this.total = 0;
        this.port.postMessage(merged, [merged.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("pinet-capture", PinetCapture);
`;

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
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    throw new Error(name === "NotAllowedError" ? "Microphone permission was denied" : "No microphone available");
  }

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  await context.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

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
