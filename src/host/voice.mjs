// Voice dictation: sealed audio in, cleaned text out.
//
// Everything happens on the host. Audio arrives as sealed chunks over the
// existing session attachment (the coordinator only ever relays ciphertext),
// is wrapped into a WAV container, and is transcribed by an STT provider. The
// raw transcript is then handed to a fast LLM that applies the cleanup
// **policy** — the editing rules, the speaker's vocabulary and the
// spoken-command conventions all live in the prompt at temperature 0, not in
// code. Two thin code-side pieces remain, and neither is a text rewrite:
//
//   * `guardResult` — advisory flags so the UI can offer a review/undo, with a
//     fallback to the raw transcript only for empty or meta-commentary output.
//   * size caps on assembled audio, so a hostile controller cannot make the
//     host transcribe unbounded input.
//
// Why the policy is prompt-side: testing showed the model handles disfluency,
// stutters, doubled words, non-speech markers and self-corrections correctly on
// its own, and that the one thing it cannot do is *know* a proper noun (asked to
// clean "pin net" it wrote "Pinnet"). Vocabulary therefore has to be stated, not
// guessed — and stating it is a policy, not a code path.

export const SAMPLE_RATE = 16_000;
export const MAX_UTTERANCE_SECONDS = 120;
export const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_UTTERANCE_SECONDS;
/** Cap on a single sealed chunk, matching the coordinator's relay limit. */
export const MAX_CHUNK_CHARS = 64 * 1024;

export class VoiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
  }
}

/**
 * The cleanup policy. Everything here is rendered into the prompt; nothing is
 * applied in code. `terms` is the speaker's vocabulary — the one input the model
 * cannot infer, and the reason this feature is configurable.
 */
export const DEFAULT_POLICIES = {
  language: "en",
  keepRegister: true,
  spokenCommands: true,
  codeConventions: true,
  terms: [
    "PiNet",
    "TypeScript",
    "JavaScript",
    "Node.js",
    "GitHub",
    "Postgres",
    "MySQL",
    "tmux",
    "npm",
    "JSON",
    "OAuth",
    "TOTP",
  ],
};

const META_PREFIX = /^\s*(here('| i)?s|sure[,!.]|certainly|i've cleaned|the cleaned|cleaned version|corrected version)/i;

/** Wrap 16-bit mono PCM in a WAV container (no ffmpeg on the host). */
export function pcm16ToWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  const dataBytes = pcm.length;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Join the base64 PCM chunks a controller streamed for one utterance. Chunks are
 * ordered by their index so an out-of-order arrival cannot scramble the audio.
 * Empty input is not an error — it just means "nothing was said".
 */
export function assembleChunks(chunks, { sampleRate = SAMPLE_RATE, maxBytes = MAX_AUDIO_BYTES } = {}) {
  const ordered = [...(chunks ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const parts = [];
  let total = 0;
  for (const chunk of ordered) {
    if (typeof chunk?.data !== "string" || !chunk.data) continue;
    const buf = Buffer.from(chunk.data, "base64");
    total += buf.length;
    if (total > maxBytes) throw new VoiceError("too_long", `utterance exceeds ${Math.round(maxBytes / (sampleRate * 2))}s`);
    parts.push(buf);
  }
  const pcm = Buffer.concat(parts);
  return {
    pcm,
    wav: pcm.length ? pcm16ToWav(pcm, sampleRate) : null,
    bytes: pcm.length,
    durationMs: Math.round((pcm.length / (sampleRate * 2)) * 1000),
  };
}

/** A short hotword hint for the STT provider (Whisper's prompt is ~224 tokens). */
export function hotwordHint(policies) {
  const terms = (policies?.terms ?? []).filter(Boolean);
  if (!terms.length) return undefined;
  return terms.slice(0, 40).join(", ").slice(0, 400);
}

/**
 * Render the cleanup policy into a system prompt. This is the whole cleanup
 * implementation: strict rules, the speaker's vocabulary, and the spoken-command
 * conventions, all at temperature 0.
 */
export function buildCleanupPrompt({ policies = DEFAULT_POLICIES, context } = {}) {
  const p = { ...DEFAULT_POLICIES, ...policies };
  const sections = [];

  sections.push(
    `You are a dictation cleanup function for spoken language (${p.language}).`,
    "Input: a raw speech transcript. Output: the same text with mechanics fixed.",
    "",
    "Rules:",
    "1. Remove filler words (um, uh, er, ah, hmm, mm) and false starts/stutters.",
    "2. Remove bracketed non-speech markers such as [SOUND], [MUSIC], [BLANK_AUDIO], (music), ♪.",
    "3. Fix punctuation, spacing and capitalisation.",
    "4. Apply the speaker's self-corrections: if they say \"no wait\" or \"I mean\" and restate something, keep only the final version.",
    "5. Preserve every number, identifier, file path, technical term and proper noun.",
    "6. Preserve line breaks exactly as given. Never join lines into one paragraph.",
    "7. Do not add information. Do not answer questions contained in the text. Do not explain anything, do not summarise, do not translate.",
    "8. If the transcript is empty or contains no meaningful speech, return it completely unchanged.",
    "9. Return only the cleaned text: no quotes, no framing, no commentary.",
  );

  if (p.keepRegister) {
    sections.push(
      "",
      "Style:",
      "- Keep the speaker's register. Do not formalise casual wording, do not expand or contract contractions (\"gonna\" stays \"gonna\"), and do not restructure sentences.",
    );
  }

  if (p.terms?.length) {
    sections.push(
      "",
      "Vocabulary (the speaker's own terms):",
      `- These are the correct spellings: ${p.terms.join(", ")}.`,
      "- When the transcript sounds like one of these, use the spelling exactly as written here. Never invent a different capitalisation, and never substitute a similar-sounding word.",
    );
    if (context?.cwd) sections.push(`- Project context: ${context.cwd}`);
  }

  if (p.spokenCommands) {
    sections.push(
      "",
      "Spoken commands (the speaker says these to mean the symbol):",
      "- \"new line\" → a line break; \"new paragraph\" → a blank line.",
      "- \"question mark\" → ?, \"exclamation mark\"/\"exclamation point\" → !.",
      "- Never apply these to the ordinary nouns \"period\" or \"comma\".",
    );
  }

  if (p.codeConventions) {
    sections.push(
      "",
      "Code and numbers:",
      "- Symbols: \"underscore\" → _, \"dash\"/\"hyphen\" → -, \"dash dash\" → --, \"slash\" → /, \"backtick\" → `, \"asterisk\" → *, \"dot\" → . in paths, hostnames, domains and identifiers.",
      "- Join dictated identifiers into one token: \"get user underscore by id\" → get_user_by_id, \"slash tmp slash foo\" → /tmp/foo.",
      "- Number words joined by \"point\" become digits: \"three point one four\" → 3.14, \"v one point two\" → v1.2. Do not convert any other number words.",
    );
  }

  return sections.join("\n");
}

// Dots count only *inside* a token, so "node.js" and "3.14" survive while a
// sentence-final period does not become part of the word (it did, and it made a
// correct cleanup look like content loss).
const words = (text) => text.toLowerCase().match(/[a-z0-9_/-]+(?:\.[a-z0-9_/-]+)*/g) ?? [];

/**
 * Assess a cleanup result against the transcript it came from.
 *
 * Advisory on purpose. A hard coverage floor was measured to *reject correct
 * output* in two ordinary cases: when the speaker self-corrects ("send it to
 * alice no wait bob") the right answer drops words, and when the vocabulary
 * policy joins a term ("pin net" → "PiNet") the token count falls even though
 * nothing was lost. So the thresholds are deliberately loose, every reason is
 * reported for the UI, and only `empty`/`meta` block the result — those are
 * unambiguous malfunctions rather than judgement calls.
 */
export function guardResult(raw, clean, { minCoverage = 0.3, maxNovelty = 0.5 } = {}) {
  const c = String(clean ?? "").trim();
  const reasons = [];
  if (!c) reasons.push("empty");
  const meta = META_PREFIX.test(c);
  if (meta) reasons.push("meta");
  const r = words(String(raw ?? ""));
  const t = words(c);
  const cSet = new Set(t);
  const rSet = new Set(r);
  const coverage = r.length ? r.filter((w) => cSet.has(w)).length / r.length : 1;
  const novelty = t.length ? t.filter((w) => !rSet.has(w)).length / t.length : 0;
  if (!meta && coverage < minCoverage) reasons.push("dropped_content");
  if (!meta && novelty > maxNovelty) reasons.push("added_content");
  return { ok: reasons.length === 0, reasons, coverage: +coverage.toFixed(2), novelty: +novelty.toFixed(2) };
}

/**
 * Speech-to-text against any OpenAI-compatible /audio/transcriptions endpoint
 * (Groq today: whisper-large-v3-turbo, ~80x realtime, $0.04/audio-hour).
 */
export function createTranscriber({ apiKey, model = "whisper-large-v3-turbo", baseUrl = "https://api.groq.com/openai/v1", fetchImpl = fetch } = {}) {
  if (!apiKey) throw new VoiceError("no_asr_key");
  return {
    model,
    async transcribe(wav, { prompt, signal } = {}) {
      const form = new FormData();
      form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
      form.append("model", model);
      form.append("response_format", "json");
      if (prompt) form.append("prompt", prompt);
      const res = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });
      if (!res.ok) throw new VoiceError("asr_failed", `asr ${res.status}`);
      const json = await res.json().catch(() => null);
      return String(json?.text ?? "").trim();
    },
  };
}

/** The cleanup pass: one fast, non-reasoning completion at temperature 0. */
export function createCleaner({ apiKey, model = "qwen/qwen3.8-27b", baseUrl = "https://api.groq.com/openai/v1", fetchImpl = fetch } = {}) {
  if (!apiKey) throw new VoiceError("no_llm_key");
  return {
    model,
    async clean(raw, { system, signal } = {}) {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: raw },
          ],
          temperature: 0,
          max_tokens: 1024,
        }),
        signal,
      });
      if (!res.ok) throw new VoiceError("cleanup_failed", `cleanup ${res.status}`);
      const json = await res.json().catch(() => null);
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new VoiceError("cleanup_failed", "malformed completion");
      return text.trim();
    },
  };
}

/**
 * Audio chunks → transcript → cleaned text, with timings so the caller can log
 * where the latency went.
 */
export class VoicePipeline {
  constructor({ transcriber, cleaner, policies = DEFAULT_POLICIES, maxBytes = MAX_AUDIO_BYTES } = {}) {
    this.transcriber = transcriber;
    this.cleaner = cleaner;
    this.policies = { ...DEFAULT_POLICIES, ...policies };
    this.maxBytes = maxBytes;
  }

  get enabled() {
    return Boolean(this.transcriber && this.cleaner);
  }

  async finish(chunks, { context, signal } = {}) {
    const started = Date.now();
    const audio = assembleChunks(chunks, { maxBytes: this.maxBytes });
    if (!audio.wav) return { text: "", raw: "", flags: ["no_speech"], timings: { totalMs: Date.now() - started } };

    const asrAt = Date.now();
    const raw = await this.transcriber.transcribe(audio.wav, { prompt: hotwordHint(this.policies), signal });
    const asrMs = Date.now() - asrAt;
    if (!raw) {
      return { text: "", raw: "", flags: ["no_speech"], durationMs: audio.durationMs, timings: { asrMs, totalMs: Date.now() - started } };
    }

    const cleanAt = Date.now();
    let cleaned;
    try {
      cleaned = await this.cleaner.clean(raw, { system: buildCleanupPrompt({ policies: this.policies, context }), signal });
    } catch (error) {
      // A failed polish must not lose what was said: hand back the transcript.
      return {
        text: raw,
        raw,
        flags: ["cleanup_failed", String(error?.code ?? "error")],
        durationMs: audio.durationMs,
        timings: { asrMs, totalMs: Date.now() - started },
      };
    }
    const cleanMs = Date.now() - cleanAt;

    const guard = guardResult(raw, cleaned);
    const blocked = guard.reasons.includes("empty") || guard.reasons.includes("meta");
    return {
      text: blocked ? raw : cleaned,
      raw,
      flags: guard.ok ? [] : guard.reasons,
      guard: { coverage: guard.coverage, novelty: guard.novelty },
      durationMs: audio.durationMs,
      timings: { asrMs, cleanMs, totalMs: Date.now() - started },
    };
  }
}

/** Resolve a provider key from the environment or pi's auth store. */
export function resolveApiKey({ env = process.env, readAuth } = {}) {
  if (env.GROQ_API_KEY) return env.GROQ_API_KEY;
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
  if (typeof readAuth === "function") {
    try {
      const auth = readAuth();
      return auth?.groq?.key ?? auth?.openai?.key ?? undefined;
    } catch {
      /* no auth store */
    }
  }
  return undefined;
}
