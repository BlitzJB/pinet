// Voice dictation, served by the coordinator.
//
// The host used to do this, which meant a provider key on every machine and two
// extra intercontinental hops (browser → hub → host → provider) per take. The
// trade, made deliberately: the audio is now readable by this server. It is
// plainly *not* private from the hub any more — though it was always going to a
// third-party provider anyway — and in exchange one key serves every host, and
// the path is a single hop.
//
// Nothing here touches the session channel: this is its own endpoint, so the
// end-to-end property of session payloads is unchanged.
//
// The pipeline is the same code the host ran (../host/voice.mjs) — it was already
// transport-agnostic, which is why this is a wiring change rather than a port.

import { DEFAULT_POLICIES, VoiceError, VoicePipeline, createCleaner, createTranscriber } from "../host/voice.mjs";

/** ~10 minutes of 16kHz mono PCM16, base64-encoded, plus JSON framing. */
export const MAX_TAKE_BYTES = 24 * 1024 * 1024;

export function createVoiceService({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = env.GROQ_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey || env.PINET_VOICE === "off") {
    return { enabled: false, side: null, transcribe: async () => ({ text: "", raw: "", flags: ["voice_disabled"] }) };
  }

  const extra = (env.PINET_VOICE_TERMS ?? "")
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);

  const pipeline = new VoicePipeline({
    transcriber: createTranscriber({
      apiKey,
      model: env.PINET_VOICE_ASR_MODEL,
      baseUrl: env.PINET_VOICE_ASR_URL,
      fetchImpl,
    }),
    cleaner: createCleaner({
      apiKey,
      model: env.PINET_VOICE_LLM_MODEL,
      baseUrl: env.PINET_VOICE_LLM_URL,
      fetchImpl,
    }),
    policies: { ...DEFAULT_POLICIES, terms: [...new Set([...DEFAULT_POLICIES.terms, ...extra])] },
    // The endpoint accepts up to MAX_TAKE_BYTES; without this the pipeline's own
    // 2-minute default silently truncated anything longer while the UI claimed ten.
    maxBytes: MAX_TAKE_BYTES,
  });

  return {
    enabled: true,
    side: "coordinator",
    /**
     * One take in, cleaned text out. Chunks are the same base64 PCM the browser
     * captured; nothing is written to disk here, so a failed take is retried from
     * the browser's own buffer rather than from a spool on this server.
     */
    async transcribe({ chunks = [], sampleRate } = {}) {
      // The recorder always sends 16kHz; anything else would be mis-wrapped as WAV.
      if (sampleRate !== undefined && Number(sampleRate) !== 16_000) {
        throw new VoiceError("unsupported_sample_rate", `expected 16000, got ${sampleRate}`);
      }
      const parts = (Array.isArray(chunks) ? chunks : [])
        .map((data, index) => ({ index, data }))
        .filter((chunk) => typeof chunk.data === "string" && chunk.data);
      if (!parts.length) return { text: "", raw: "", flags: ["no_speech"] };

      const result = await pipeline.finish(parts);
      return {
        text: result.text,
        raw: result.raw,
        flags: result.flags,
        durationMs: result.durationMs,
        segments: result.segments,
      };
    },
  };
}
