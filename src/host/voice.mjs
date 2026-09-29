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

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SAMPLE_RATE = 16_000;
/**
 * One upload per segment. Providers are fast on short audio and unreliable on
 * long audio, so the *request* is capped here rather than the utterance: a long
 * take becomes several segments that are transcribed in order and joined. A
 * single 120s ceiling used to reject the whole take, which is how a long
 * dictation was lost.
 */
export const MAX_SEGMENT_SECONDS = 45;
/** Overall bound, so a runaway recording cannot make the host work forever. */
export const MAX_UTTERANCE_SECONDS = 600;
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
/**
 * Reasoning about the task rather than doing it.
 *
 * Deliberately shaped as predicates, not keywords: "the transcript" or "the
 * input" appear in ordinary dictation ("send me the transcript"), so matching
 * those alone rejected perfectly good text.
 */
const META_TALK = new RegExp(
  [
    "\\bnot\\s+(?:in\\s+)?english\\b",
    "\\bno\\s+(?:recognizable|meaningful)\\s+(?:speech|content|english)\\b",
    "\\baccording\\s+to\\s+rule\\s+\\d+\\b",
    "\\breturn(?:ed|ing)?\\s+(?:it\\s+|the\\s+text\\s+|the\\s+input\\s+)?unchanged\\b",
    "\\bthe\\s+input\\s+(?:text\\s+)?(?:is|appears|seems)\\b",
    "\\b(?:appears|seems)\\s+to\\s+be\\s+(?:a\\s+|an\\s+)?(?:string|series|sequence)\\b",
    "\\bi\\s+(?:cannot|can't|won't|will\\s+not)\\s+(?:clean|process|transcribe|assist)\\b",
    "\\bas\\s+an\\s+ai\\b",
  ].join("|"),
  "i",
);

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
export function assembleChunks(chunks, { sampleRate = SAMPLE_RATE, maxBytes = MAX_AUDIO_BYTES, truncate = true } = {}) {
  const ordered = [...(chunks ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const parts = [];
  let total = 0;
  let truncated = false;
  for (const chunk of ordered) {
    if (typeof chunk?.data !== "string" || !chunk.data) continue;
    const buf = Buffer.from(chunk.data, "base64");
    if (total + buf.length > maxBytes) {
      // Truncating keeps the recording recoverable; throwing used to lose the
      // whole take, which is how a long dictation disappeared.
      if (!truncate) throw new VoiceError("too_long", `utterance exceeds ${Math.round(maxBytes / (sampleRate * 2))}s`);
      if (total < maxBytes) parts.push(buf.subarray(0, maxBytes - total));
      truncated = true;
      break;
    }
    total += buf.length;
    parts.push(buf);
  }
  const pcm = Buffer.concat(parts);
  return {
    pcm,
    wav: pcm.length ? pcm16ToWav(pcm, sampleRate) : null,
    bytes: pcm.length,
    truncated,
    durationMs: Math.round((pcm.length / (sampleRate * 2)) * 1000),
  };
}

/**
 * A local spool of dictated audio, kept on the machine that captured it.
 *
 * Written before transcription, so a provider failure, a crash or a bad
 * transcript never costs the recording — the take can be retried from here. The
 * spool is bounded by take count and total bytes and prunes oldest-first,
 * preferring to drop takes that already transcribed over ones awaiting a retry.
 * Audio never goes anywhere except the configured provider.
 */
export class VoiceSpool {
  constructor({ dir, maxTakes = 20, maxBytes = 200 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.maxTakes = maxTakes;
    this.maxBytes = maxBytes;
    // Same-millisecond takes used to sort by a random suffix, so "newest" and
    // pruning order were arbitrary. The counter makes ids chronological.
    this.sequence = 0;
  }

  get enabled() {
    return Boolean(this.dir);
  }

  #path(id, extension) {
    return join(this.dir, `${id}.${extension}`);
  }

  /** Persist one take and return its id. */
  save({ pcm, sampleRate = SAMPLE_RATE, meta = {} }) {
    if (!this.dir) return undefined;
    mkdirSync(this.dir, { recursive: true });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(this.sequence++).padStart(4, "0")}-${Math.random().toString(36).slice(2, 6)}`;
    writeFileSync(this.#path(id, "wav"), pcm16ToWav(pcm, sampleRate));
    writeFileSync(
      this.#path(id, "json"),
      JSON.stringify(
        {
          id,
          createdAt: new Date().toISOString(),
          durationMs: Math.round((pcm.length / (sampleRate * 2)) * 1000),
          bytes: pcm.length,
          status: "pending",
          attempts: 0,
          ...meta,
        },
        null,
        2,
      ),
    );
    this.prune();
    return id;
  }

  /** Record the outcome alongside the audio. */
  mark(id, patch) {
    if (!this.dir || !id) return;
    try {
      const meta = JSON.parse(readFileSync(this.#path(id, "json"), "utf8"));
      writeFileSync(this.#path(id, "json"), JSON.stringify({ ...meta, ...patch }, null, 2));
    } catch {
      /* the take was pruned */
    }
  }

  /** Read a take back for a retry. */
  load(id) {
    if (!this.dir) throw new VoiceError("no_spool");
    const wav = readFileSync(this.#path(id, "wav"));
    const meta = JSON.parse(readFileSync(this.#path(id, "json"), "utf8"));
    return { pcm: wav.subarray(44), meta };
  }

  list() {
    if (!this.dir) return [];
    try {
      return readdirSync(this.dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          try {
            return JSON.parse(readFileSync(join(this.dir, name), "utf8"));
          } catch {
            return undefined;
          }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.id).localeCompare(String(a.id)));
    } catch {
      return [];
    }
  }

  /** The most recent take that still needs transcribing. */
  latestRetryable() {
    return this.list().find((entry) => entry.status === "failed" || entry.status === "pending");
  }

  prune() {
    if (!this.dir) return;
    const entries = this.list();
    let bytes = entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0);
    // Successfully transcribed takes go first: a failed one is the whole point of
    // keeping the audio.
    const removable = [...entries].reverse().sort((a, b) => Number(b.status === "ok") - Number(a.status === "ok"));
    while (removable.length > this.maxTakes || bytes > this.maxBytes) {
      const entry = removable.shift();
      if (!entry) break;
      bytes -= entry.bytes ?? 0;
      for (const extension of ["wav", "json"]) {
        try {
          rmSync(this.#path(entry.id, extension), { force: true });
        } catch {
          /* already gone */
        }
      }
    }
  }
}

/**
 * The byte offset to cut at, preferring the quietest moment near `nominalByte` so
 * a segment boundary lands in a pause rather than inside a word.
 */
export function findCutPoint(pcm, nominalByte, { sampleRate = SAMPLE_RATE, searchSeconds = 1.5, windowMs = 20 } = {}) {
  const bytesPerSample = 2;
  const searchBytes = Math.round(sampleRate * searchSeconds) * bytesPerSample;
  const windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const from = Math.max(0, nominalByte - searchBytes) / bytesPerSample;
  const to = Math.min(pcm.length, nominalByte + searchBytes) / bytesPerSample;
  if (to - from <= windowSamples) return nominalByte;
  const step = Math.max(1, Math.floor(windowSamples / 2));
  const windows = [];
  let quietest = Infinity;
  for (let sample = from; sample + windowSamples <= to; sample += step) {
    let energy = 0;
    for (let i = 0; i < windowSamples; i += 1) {
      const value = pcm.readInt16LE((sample + i) * bytesPerSample);
      energy += value * value;
    }
    const byte = (sample + Math.floor(windowSamples / 2)) * bytesPerSample;
    windows.push({ byte, energy });
    if (energy < quietest) quietest = energy;
  }
  // Among windows that are as quiet as the quietest (uniform audio has no clear
  // pause), take the one nearest the nominal boundary. Picking the first match
  // instead made every cut creep backwards, segment after segment.
  const threshold = quietest * 1.2 + 1;
  let bestByte = nominalByte;
  let bestDistance = Infinity;
  for (const window of windows) {
    if (window.energy > threshold) continue;
    const distance = Math.abs(window.byte - nominalByte);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestByte = window.byte;
    }
  }
  return bestByte;
}

/**
 * Split PCM into provider-sized segments, cutting near silence. Every byte is
 * kept and each segment is at least half a segment long, so this always
 * progresses.
 */
export function splitPcm(pcm, { sampleRate = SAMPLE_RATE, segmentSeconds = MAX_SEGMENT_SECONDS } = {}) {
  const bytesPerSegment = sampleRate * 2 * segmentSeconds;
  const segments = [];
  let start = 0;
  while (start < pcm.length) {
    const nominal = start + bytesPerSegment;
    if (nominal >= pcm.length) {
      segments.push(pcm.subarray(start));
      break;
    }
    const end = Math.max(start + Math.floor(bytesPerSegment / 2), Math.min(findCutPoint(pcm, nominal, { sampleRate }), pcm.length));
    segments.push(pcm.subarray(start, end));
    start = end;
  }
  // A sliver at the end is not worth a provider round trip; fold it in.
  const minTail = sampleRate * 2 * 2;
  if (segments.length > 1 && segments[segments.length - 1].length < minTail) {
    const tail = segments.pop();
    segments[segments.length - 1] = Buffer.concat([segments[segments.length - 1], tail]);
  }
  return segments;
}

const normaliseWord = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * The words a segment repeats from the end of the previous one. Whisper restarts
 * each request without knowing what came before, so a sentence spanning a cut is
 * often echoed; this is the "chunk intelligence" that keeps the join clean.
 */
export function seamOverlap(previous, next, maxWords = 8) {
  const a = String(previous ?? "").split(/\s+/).filter(Boolean);
  const b = String(next ?? "").split(/\s+/).filter(Boolean);
  for (let count = Math.min(maxWords, a.length, b.length); count >= 1; count -= 1) {
    const tail = a.slice(-count).map(normaliseWord).join(" ");
    const head = b.slice(0, count).map(normaliseWord).join(" ");
    if (tail && tail === head) return b.slice(0, count).join(" ");
  }
  return "";
}

/** Join segment transcripts in order, dropping anything duplicated at a seam. */
export function joinTranscripts(parts, { maxWords = 8 } = {}) {
  const kept = [];
  for (const part of parts ?? []) {
    const text = String(part ?? "").trim();
    if (!text) continue;
    if (!kept.length) {
      kept.push(text);
      continue;
    }
    const overlap = seamOverlap(kept[kept.length - 1], text, maxWords);
    kept.push(overlap ? text.slice(overlap.length).trim() : text);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
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
    "You are a dictation cleanup function. Input: a raw speech transcript, in",
    "whatever language the speaker used. Output: the same text with mechanics fixed.",
    "",
    "Rules:",
    "0. Work in the language that was spoken. If the text is not English, clean it in",
    "   its own language and never translate it. Never remark on the language.",
    "1. Remove filler words (in English: um, uh, er, ah, hmm, mm — or the equivalent",
    "   in the language being spoken) and false starts/stutters.",
    "2. Remove bracketed non-speech markers such as [SOUND], [MUSIC], [BLANK_AUDIO], (music), ♪.",
    "3. Fix punctuation, spacing and capitalisation.",
    "4. Apply the speaker's self-corrections: if they say \"no wait\" or \"I mean\" and restate something, keep only the final version.",
    "5. Preserve every number, identifier, file path, technical term and proper noun.",
    "6. Preserve line breaks exactly as given. Never join lines into one paragraph.",
    "7. Do not add information. Do not answer questions contained in the text. Do not explain anything, do not summarise, do not translate.",
    "8. If there is nothing to fix — including when the text is too short, unclear or",
    "   in a language you do not recognise — return the input text verbatim.",
    "9. Output ONLY the resulting text. Never explain what you did, never quote these",
    "   rules, never mention the language or the input, never add notes or framing.",
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
/** Whitespace/case-insensitive form, for spotting a transcript inside prose. */
const flatten = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The transcript, if the model wrapped it in prose.
 *
 * Asked to clean something it finds odd (a language it does not expect, say) a
 * model sometimes replies with an explanation *plus* the untouched transcript.
 * Rather than throw that away, recover the text it preserved.
 */
export function extractTranscript(raw, clean) {
  const needle = flatten(raw);
  if (needle.length < 8) return undefined;
  const haystack = flatten(clean);
  // Nothing was wrapped: the model just did its job.
  if (haystack === needle) return undefined;
  const at = haystack.indexOf(needle);
  if (at < 0) return undefined;
  // Map the flattened match back to the original by walking words.
  const before = haystack.slice(0, at).split(" ").filter(Boolean).length;
  const count = needle.split(" ").filter(Boolean).length;
  const parts = String(clean).trim().split(/\s+/);
  return parts.slice(before, before + count).join(" ").trim() || undefined;
}

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
  const meta = META_PREFIX.test(c) || META_TALK.test(c);
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
    async transcribe(wav, { prompt, signal, onMeta } = {}) {
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
      onMeta?.({ status: res.status, headers: res.headers });
      if (!res.ok) {
        const error = new VoiceError("asr_failed", `asr ${res.status}`);
        error.retryable = res.status === 429 || res.status >= 500;
        throw error;
      }
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
/** "1.2s" / "500ms" / "2m59.56s" → milliseconds, as Groq's reset headers use. */
export function parseDuration(value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const match = /^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
  if (match) return (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 1000;
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(text);
  return ms ? Number(ms[1]) : undefined;
}

/** "30" (seconds) or an HTTP date, per RFC 9110. */
export function parseRetryAfter(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * Paces transcription requests against the provider's own rate-limit signals
 * rather than guessing with blind sleeps.
 *
 * - A fixed concurrency ceiling keeps the burst small.
 * - `429` (or a `retry-after`) closes a gate until the provider's stated reset,
 *   and halves concurrency; each success adds one back.
 * - The `x-ratelimit-remaining-*` / `-reset-*` headers close the gate *before*
 *   the limit is hit, so a long take queues instead of failing.
 */
export class RateLimiter {
  constructor({ concurrency = 4, minConcurrency = 1, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.maxConcurrency = concurrency;
    this.concurrency = concurrency;
    this.minConcurrency = minConcurrency;
    this.now = now;
    this.sleep = sleep;
    this.requests = 0;
    this.throttled = 0;
    this.gateUntil = 0;
    this.queue = [];
    this.active = 0;
    this.timer = undefined;
  }

  get stats() {
    return { concurrency: this.concurrency, requests: this.requests, throttled: this.throttled, queued: this.queue.length };
  }

  acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.#pump();
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.#pump();
  }

  /** Wait until the gate opens — used between retries so the delay is the provider's. */
  async waitForGate() {
    for (;;) {
      const remaining = this.gateUntil - this.now();
      if (remaining <= 0) return;
      await this.sleep(remaining);
    }
  }

  /** Feed back what the provider said, so the next dispatch is better informed. */
  observe({ status, headers } = {}) {
    const header = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
    if (status === 429) {
      this.throttled += 1;
      this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2));
      const until = this.now() + Math.max(parseRetryAfter(header("retry-after"), this.now()) ?? 0, parseDuration(header("x-ratelimit-reset-requests")) ?? 0, 250);
      this.gateUntil = Math.max(this.gateUntil, until);
      this.#pump();
      return;
    }
    if (typeof status === "number" && status < 400) {
      if (this.concurrency < this.maxConcurrency) this.concurrency += 1;
      // Hold back before the ceiling is reached rather than after a 429.
      const remaining = Number(header("x-ratelimit-remaining-requests"));
      const resetIn = parseDuration(header("x-ratelimit-reset-requests"));
      if (Number.isFinite(remaining) && remaining <= 1 && resetIn) this.gateUntil = Math.max(this.gateUntil, this.now() + resetIn);
    }
  }

  #pump() {
    if (this.timer) return;
    if (!this.queue.length) return;
    const wait = this.gateUntil - this.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.#pump();
      }, wait);
      this.timer.unref?.();
      return;
    }
    while (this.queue.length && this.active < this.concurrency) {
      this.active += 1;
      this.requests += 1;
      this.queue.shift()();
    }
  }
}

/** Transient failures worth another attempt; anything else is reported at once. */
const isRetryable = (error) => error?.retryable === true;
const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      reject(new VoiceError("aborted"));
    });
  });

export class VoicePipeline {
  constructor({ transcriber, cleaner, policies = DEFAULT_POLICIES, maxBytes = MAX_AUDIO_BYTES, attempts = 3, concurrency = 4, limiter } = {}) {
    this.transcriber = transcriber;
    this.cleaner = cleaner;
    this.policies = { ...DEFAULT_POLICIES, ...policies };
    this.maxBytes = maxBytes;
    this.attempts = attempts;
    this.limiter = limiter ?? new RateLimiter({ concurrency });
  }

  get enabled() {
    return Boolean(this.transcriber && this.cleaner);
  }

  /**
   * One segment. Retries wait on the limiter's gate rather than a fixed backoff,
   * so the pause is the one the provider actually asked for.
   */
  async #transcribeSegment(segment, prompt, signal) {
    let last;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        return await this.transcriber.transcribe(pcm16ToWav(segment), {
          prompt,
          signal,
          onMeta: (meta) => this.limiter.observe(meta),
        });
      } catch (error) {
        last = error;
        if (!isRetryable(error) || attempt === this.attempts) break;
        await this.limiter.waitForGate();
      }
    }
    throw last;
  }

  /**
   * Transcribe every segment, in parallel, paced by the limiter, then join the
   * transcripts in order. Segments are cut near silence, so a request rarely
   * begins mid-sentence; whatever is duplicated across a seam is dropped.
   */
  async #transcribe(pcm, { signal } = {}) {
    const segments = splitPcm(pcm);
    const prompt = hotwordHint(this.policies);
    const results = await Promise.all(
      segments.map(async (_segment, index) => {
        await this.limiter.acquire();
        try {
          return await this.#transcribeSegment(segments[index], prompt, signal);
        } finally {
          this.limiter.release();
        }
      }),
    );
    return { raw: joinTranscripts(results), segments: segments.length };
  }

  /** Transcript → cleaned text, with the guard. Never throws for a bad polish. */
  async #clean(raw, { context, signal, asrMs, started } = {}) {
    const cleanAt = Date.now();
    let cleaned;
    try {
      cleaned = await this.cleaner.clean(raw, { system: buildCleanupPrompt({ policies: this.policies, context }), signal });
    } catch (error) {
      // A failed polish must not lose what was said: hand back the transcript.
      return { text: raw, raw, flags: ["cleanup_failed", String(error?.code ?? "error")], timings: { asrMs, totalMs: Date.now() - started } };
    }
    const guard = guardResult(raw, cleaned);
    const blocked = guard.reasons.includes("empty") || guard.reasons.includes("meta");
    // If it explained itself but also returned the transcript, keep the transcript.
    const recovered = blocked && !guard.reasons.includes("empty") ? extractTranscript(raw, cleaned) : undefined;
    return {
      text: recovered ?? (blocked ? raw : cleaned),
      recovered: Boolean(recovered),
      raw,
      flags: guard.ok ? [] : guard.reasons,
      guard: { coverage: guard.coverage, novelty: guard.novelty },
      timings: { asrMs, cleanMs: Date.now() - cleanAt, totalMs: Date.now() - started },
    };
  }

  async #run(pcm, { context, signal, started = Date.now(), segments: known, truncated } = {}) {
    const asrAt = Date.now();
    const { raw, segments } = await this.#transcribe(pcm, { signal });
    const asrMs = Date.now() - asrAt;
    const flags = truncated ? ["truncated"] : [];
    if (!raw) {
      return { text: "", raw: "", flags: [...flags, "no_speech"], durationMs: Math.round((pcm.length / (SAMPLE_RATE * 2)) * 1000), segments: segments ?? known, timings: { asrMs, totalMs: Date.now() - started } };
    }
    const cleaned = await this.#clean(raw, { context, signal, asrMs, started });
    return {
      ...cleaned,
      flags: [...flags, ...cleaned.flags],
      durationMs: Math.round((pcm.length / (SAMPLE_RATE * 2)) * 1000),
      segments: segments ?? known,
      rateLimit: this.limiter.stats,
    };
  }

  /**
   * Audio in, cleaned text out. The recording is spooled before any provider is
   * called, so a failure downstream costs a retry, not the take.
   */
  async finish(chunks, { context, signal, spool } = {}) {
    const started = Date.now();
    const audio = assembleChunks(chunks, { maxBytes: this.maxBytes });
    if (!audio.wav) return { text: "", raw: "", flags: ["no_speech"], timings: { totalMs: Date.now() - started } };

    const spoolId = spool?.save({ pcm: audio.pcm, meta: { context: context?.cwd ?? null, truncated: Boolean(audio.truncated) } });
    try {
      const result = await this.#run(audio.pcm, { context, signal, started, truncated: audio.truncated });
      spool?.mark(spoolId, { status: result.text ? "ok" : "empty", raw: result.raw, text: result.text, segments: result.segments, flags: result.flags });
      return { ...result, spoolId };
    } catch (error) {
      // Keep the audio and the reason: this is what makes a retry possible.
      spool?.mark(spoolId, { status: "failed", error: String(error?.code ?? error?.message ?? error) });
      throw error;
    }
  }

  /** Re-run a spooled take (see VoiceSpool). */
  async retry(spoolId, { context, signal, spool } = {}) {
    if (!spool?.enabled) throw new VoiceError("no_spool");
    const id = spoolId ?? spool.latestRetryable()?.id;
    if (!id) throw new VoiceError("nothing_to_retry");
    const { pcm } = spool.load(id);
    const started = Date.now();
    spool.mark(id, { status: "pending", attempts: 1 });
    try {
      const result = await this.#run(pcm, { context, signal, started });
      spool.mark(id, { status: result.text ? "ok" : "empty", raw: result.raw, text: result.text, segments: result.segments, flags: result.flags });
      return { ...result, spoolId: id, retried: true };
    } catch (error) {
      spool.mark(id, { status: "failed", error: String(error?.code ?? error?.message ?? error) });
      throw error;
    }
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
