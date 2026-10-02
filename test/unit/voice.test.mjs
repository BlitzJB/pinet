import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICIES,
  RateLimiter,
  SAMPLE_RATE as SAMPLE_RATE_HZ,
  MAX_AUDIO_BYTES,
  VoiceError,
  VoicePipeline,
  VoiceError,
  VoiceSpool,
  assembleChunks,
  buildCleanupPrompt,
  extractTranscript,
  findCutPoint,
  joinTranscripts,
  parseDuration,
  parseRetryAfter,
  splitPcm,
  guardResult,
  hotwordHint,
  pcm16ToWav,
  resolveApiKey,
} from "../../src/host/voice.mjs";

const pcm = (samples) => Buffer.from(Int16Array.from(samples).buffer);
const b64 = (buf) => Buffer.from(buf).toString("base64");
// Sample well inside a segment: cuts deliberately straddle the boundary by up to
// one 20ms window, so the first byte is not a reliable marker.
const marker = (wav) => wav.readUInt8(44 + Math.floor((wav.length - 44) / 2));

describe("voice: audio assembly", () => {
  it("wraps PCM in a valid mono WAV header", () => {
    const wav = pcm16ToWav(pcm([0, 100, -100]), 16_000);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.readUInt32LE(4)).toBe(36 + 6);
  });

  it("joins chunks in index order and reports the duration", () => {
    const first = pcm([1, 1]);
    const second = pcm([2, 2]);
    const out = assembleChunks([
      { index: 1, data: b64(second) },
      { index: 0, data: b64(first) },
    ]);
    expect(out.pcm.equals(Buffer.concat([first, second]))).toBe(true);
    expect(out.bytes).toBe(8);
    expect(out.durationMs).toBe(0);
  });

  it("treats empty audio as 'nothing said' rather than an error", () => {
    const out = assembleChunks([]);
    expect(out.wav).toBeNull();
    expect(out.bytes).toBe(0);
  });

  it("truncates at the cap rather than discarding the take", () => {
    // Throwing here used to lose a long dictation entirely.
    const huge = Buffer.alloc(MAX_AUDIO_BYTES + 6000).toString("base64");
    const out = assembleChunks([{ index: 0, data: huge }]);
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBe(MAX_AUDIO_BYTES);
    expect(() => assembleChunks([{ index: 0, data: huge }], { truncate: false })).toThrow(VoiceError);
  });
});

describe("voice: cleanup policy lives in the prompt", () => {
  it("states the speaker's vocabulary, since the model cannot infer it", () => {
    const prompt = buildCleanupPrompt({ policies: { ...DEFAULT_POLICIES, terms: ["PiNet", "tmux"] } });
    expect(prompt).toContain("PiNet, tmux");
    expect(prompt).toMatch(/Never invent a different capitalisation/);
  });

  it("covers the spoken-command and code conventions", () => {
    const prompt = buildCleanupPrompt();
    expect(prompt).toContain('"new line" → a line break');
    expect(prompt).toContain("get_user_by_id");
    expect(prompt).toContain('"three point one four" → 3.14');
    // The trap we measured: plain nouns must not be treated as commands.
    expect(prompt).toMatch(/Never apply these to the ordinary nouns "period" or "comma"/);
  });

  it("keeps the register and the line breaks", () => {
    const prompt = buildCleanupPrompt();
    expect(prompt).toMatch(/gonna" stays "gonna"/);
    expect(prompt).toMatch(/Preserve line breaks exactly/);
  });

  it("omits optional sections when disabled", () => {
    const prompt = buildCleanupPrompt({ policies: { spokenCommands: false, codeConventions: false, keepRegister: false } });
    expect(prompt).not.toContain("Spoken commands");
    expect(prompt).not.toContain("Code and numbers");
    expect(prompt).not.toContain("Style:");
  });

  it("builds a short hotword hint for the STT provider", () => {
    expect(hotwordHint({ terms: ["PiNet", "tmux"] })).toBe("PiNet, tmux");
    expect(hotwordHint({ terms: [] })).toBeUndefined();
  });
});

describe("voice: guard is advisory", () => {
  it("passes a faithful cleanup", () => {
    const guard = guardResult("um send it to bob", "Send it to bob.");
    expect(guard.ok).toBe(true);
    expect(guard.reasons).toEqual([]);
  });

  it("flags meta-commentary and empty output", () => {
    expect(guardResult("hello", "Here's the cleaned version: hello").reasons).toContain("meta");
    expect(guardResult("hello", "   ").reasons).toContain("empty");
  });

  it("tolerates the word loss a self-correction implies", () => {
    // "alice no wait bob" -> correct output drops words; a hard coverage floor
    // rejected exactly this, which is why the thresholds are loose.
    const guard = guardResult("send the report to alice no wait bob actually send it to bob", "send the report to bob");
    expect(guard.ok).toBe(true);
    expect(guard.coverage).toBeLessThan(0.8);
  });

  it("flags invented content", () => {
    const guard = guardResult("ship the fix", "Ship the fix, and also add tests, update the docs, and notify the team about the release");
    expect(guard.reasons).toContain("added_content");
  });
});

describe("voice: pipeline", () => {
  const asr = (text) => ({ transcribe: async () => text });
  const cleaner = (text) => ({ clean: async () => text });

  it("returns the cleaned text plus the raw transcript", async () => {
    const pipeline = new VoicePipeline({ transcriber: asr("um the pin net thing"), cleaner: cleaner("The PiNet thing.") });
    const result = await pipeline.finish([{ index: 0, data: b64(pcm([1, 2, 3, 4])) }]);
    expect(result.text).toBe("The PiNet thing.");
    expect(result.raw).toBe("um the pin net thing");
    expect(result.flags).toEqual([]);
  });

  it("never calls the model when there is no audio", async () => {
    let called = false;
    const pipeline = new VoicePipeline({ transcriber: asr("x"), cleaner: { clean: async () => ((called = true), "x") } });
    const result = await pipeline.finish([]);
    expect(result.flags).toEqual(["no_speech"]);
    expect(called).toBe(false);
  });

  it("falls back to the raw transcript when cleanup fails", async () => {
    const pipeline = new VoicePipeline({
      transcriber: asr("the raw words"),
      cleaner: { clean: async () => { throw new VoiceError("cleanup_failed"); } },
    });
    const result = await pipeline.finish([{ index: 0, data: b64(pcm([1, 2])) }]);
    expect(result.text).toBe("the raw words");
    expect(result.flags).toContain("cleanup_failed");
  });

  it("prefers the raw transcript over meta-commentary", async () => {
    const pipeline = new VoicePipeline({ transcriber: asr("ship it"), cleaner: cleaner("Sure! Here's the cleaned text: ship it.") });
    const result = await pipeline.finish([{ index: 0, data: b64(pcm([1, 2])) }]);
    expect(result.text).toBe("ship it");
    expect(result.flags).toContain("meta");
  });

  it("reports no_speech when the provider returns nothing", async () => {
    const pipeline = new VoicePipeline({ transcriber: asr(""), cleaner: cleaner("x") });
    expect((await pipeline.finish([{ index: 0, data: b64(pcm([1, 2])) }])).flags).toEqual(["no_speech"]);
  });
});

describe("voice: key resolution", () => {
  it("prefers the environment, then falls back to pi's auth store", () => {
    expect(resolveApiKey({ env: { GROQ_API_KEY: "env-key" } })).toBe("env-key");
    expect(resolveApiKey({ env: {}, readAuth: () => ({ groq: { key: "auth-key" } }) })).toBe("auth-key");
    expect(resolveApiKey({ env: {}, readAuth: () => { throw new Error("no file"); } })).toBeUndefined();
  });
});

describe("voice: long takes are segmented, not rejected", () => {
  const seconds = (count) => Buffer.alloc(SAMPLE_RATE_HZ * 2 * count, 1);

  it("splits into provider-sized segments and keeps every byte", () => {
    const pcm = seconds(100);
    const segments = splitPcm(pcm);
    expect(segments.length).toBeGreaterThan(1);
    expect(Buffer.concat(segments).length).toBe(pcm.length);
    // The last segment is whatever is left over, so only the others are full-size.
    for (const segment of segments.slice(0, -1)) expect(segment.length).toBeGreaterThanOrEqual(SAMPLE_RATE_HZ * 2 * 22);
    for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(SAMPLE_RATE_HZ * 2 * 47);
    for (const segment of segments) expect(segment.length).toBeGreaterThan(0);
  });

  it("prefers to cut in a pause, so words are not split", () => {
    // Loud, then a silent gap, then loud again. The nominal cut lands in the gap.
    const loud = Buffer.alloc(SAMPLE_RATE_HZ * 2 * 2, 0);
    for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(9000, i);
    const quiet = Buffer.alloc(SAMPLE_RATE_HZ * 2, 0);
    const pcm = Buffer.concat([loud, quiet, loud]);
    const cut = findCutPoint(pcm, loud.length + SAMPLE_RATE_HZ); // 1s into the gap
    expect(cut).toBeGreaterThanOrEqual(loud.length);
    expect(cut).toBeLessThanOrEqual(loud.length + quiet.length);
  });

  it("transcribes every segment and joins the transcripts in order", async () => {
    // Each 45s region carries a different byte, so the transcript proves both that
    // every segment was sent and that they were joined in order. (Identical
    // outputs would be collapsed by the seam de-duplication.)
    const region = (byte, count) => Buffer.alloc(SAMPLE_RATE_HZ * 2 * count, byte);
    const pcm = Buffer.concat([region(1, 45), region(2, 45), region(3, 20)]);
    const pipeline = new VoicePipeline({
      transcriber: { transcribe: async (wav) => `s${marker(wav)}` },
      cleaner: { clean: async (raw) => raw },
    });
    const result = await pipeline.finish([{ index: 0, data: pcm.toString("base64") }]);
    expect(result.segments).toBe(3);
    expect(result.raw).toBe("s1 s2 s3");
    expect(result.flags).toEqual([]);
  });
});

describe("voice: retries and the local spool", () => {
  const sample = () => Buffer.alloc(SAMPLE_RATE_HZ * 2, 3).toString("base64");
  const dir = () => mkdtempSync(join(tmpdir(), "pinet-spool-"));

  it("retries a transient provider failure", async () => {
    let attempts = 0;
    const pipeline = new VoicePipeline({
      attempts: 3,
      retryDelayMs: 1,
      transcriber: {
        transcribe: async () => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new VoiceError("asr_failed", "asr 429"), { retryable: true });
          return "the words";
        },
      },
      cleaner: { clean: async (raw) => raw },
    });
    expect((await pipeline.finish([{ index: 0, data: sample() }])).text).toBe("the words");
    expect(attempts).toBe(2);
  });

  it("saves the audio before transcribing, so a failure keeps the take", async () => {
    const spoolDir = dir();
    const spool = new VoiceSpool({ dir: spoolDir });
    const pipeline = new VoicePipeline({
      attempts: 1,
      transcriber: { transcribe: async () => { throw new VoiceError("asr_failed", "asr 500"); } },
      cleaner: { clean: async (raw) => raw },
    });
    await expect(pipeline.finish([{ index: 0, data: sample() }], { spool })).rejects.toThrow(VoiceError);

    const [entry] = spool.list();
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("asr_failed");
    // ...and the WAV is still readable for a retry.
    const { pcm } = spool.load(entry.id);
    expect(pcm.length).toBe(SAMPLE_RATE_HZ * 2);
    rmSync(spoolDir, { recursive: true, force: true });
  });

  it("retries a spooled take and marks it ok", async () => {
    const spoolDir = dir();
    const spool = new VoiceSpool({ dir: spoolDir });
    let working = false;
    const pipeline = new VoicePipeline({
      attempts: 1,
      transcriber: { transcribe: async () => { if (!working) throw new VoiceError("asr_failed", "asr 500"); return "recovered"; } },
      cleaner: { clean: async (raw) => raw },
    });
    await expect(pipeline.finish([{ index: 0, data: sample() }], { spool })).rejects.toThrow();
    const failed = spool.latestRetryable();
    expect(failed).toBeTruthy();

    working = true;
    const result = await pipeline.retry(failed.id, { spool });
    expect(result.text).toBe("recovered");
    expect(result.retried).toBe(true);
    expect(spool.list().find((entry) => entry.id === failed.id).status).toBe("ok");
    rmSync(spoolDir, { recursive: true, force: true });
  });

  it("prunes oldest-first, dropping transcribed takes before failed ones", () => {
    const spoolDir = dir();
    const spool = new VoiceSpool({ dir: spoolDir, maxTakes: 2 });
    const ids = [spool.save({ pcm: Buffer.alloc(4) }), spool.save({ pcm: Buffer.alloc(4) }), spool.save({ pcm: Buffer.alloc(4) })];
    spool.mark(ids[0], { status: "ok" });
    spool.mark(ids[1], { status: "failed" });
    spool.mark(ids[2], { status: "ok" });
    spool.prune();
    const remaining = spool.list().map((entry) => entry.status).sort();
    // The failed take survives its younger sibling when the budget is tight.
    expect(remaining).toContain("failed");
    expect(spool.list().length).toBeLessThanOrEqual(2);
    rmSync(spoolDir, { recursive: true, force: true });
  });
});

describe("voice: rate limiting follows the provider, not a timer", () => {
  const headers = (entries) => ({ get: (name) => entries[name] ?? null });

  it("caps concurrency", async () => {
    const limiter = new RateLimiter({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await limiter.acquire();
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        limiter.release();
      }),
    );
    expect(peak).toBe(2);
  });

  it("waits out retry-after and halves concurrency", async () => {
    const limiter = new RateLimiter({ concurrency: 4 });
    const started = Date.now();
    limiter.observe({ status: 429, headers: headers({ "retry-after": "0.08" }) });
    expect(limiter.concurrency).toBe(2);
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(limiter.stats.throttled).toBe(1);
    limiter.release();
  });

  it("holds back before the ceiling rather than after a 429", async () => {
    const limiter = new RateLimiter({ concurrency: 4 });
    limiter.observe({ status: 200, headers: headers({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "0.08s" }) });
    const started = Date.now();
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(limiter.stats.throttled).toBe(0); // anticipated, never throttled
    limiter.release();
  });

  it("recovers concurrency one success at a time", () => {
    const limiter = new RateLimiter({ concurrency: 4 });
    limiter.observe({ status: 429, headers: headers({}) });
    expect(limiter.concurrency).toBe(2);
    limiter.observe({ status: 200, headers: headers({}) });
    expect(limiter.concurrency).toBe(3);
    expect(limiter.maxConcurrency).toBe(4);
  });

  it("understands the durations and dates the provider sends", () => {
    expect(parseDuration("1.2s")).toBe(1200);
    expect(parseDuration("2m59.56s")).toBe(179560);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("nonsense")).toBeUndefined();
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
  });
});

describe("voice: joining chunk transcripts", () => {
  it("drops words echoed across a seam", () => {
    expect(joinTranscripts(["the cat sat on the", "on the mat"])).toBe("the cat sat on the mat");
    expect(joinTranscripts(["deploy the fix", "fix, then restart"])).toBe("deploy the fix then restart");
    expect(joinTranscripts(["unrelated end", "another start"])).toBe("unrelated end another start");
  });

  it("keeps order and skips empty segments", () => {
    expect(joinTranscripts(["one", "", "   ", "two"])).toBe("one two");
    expect(joinTranscripts([])).toBe("");
  });
});

describe("voice: transcription runs in parallel", () => {
  it("requests segments concurrently under the limit, and joins them in order", async () => {
    let active = 0;
    let peak = 0;
    const region = (byte, count) => Buffer.alloc(SAMPLE_RATE_HZ * 2 * count, byte);
    const pipeline = new VoicePipeline({
      limiter: new RateLimiter({ concurrency: 2 }),
      transcriber: {
        transcribe: async (wav) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return `s${marker(wav)}`;
        },
      },
      cleaner: { clean: async (raw) => raw },
    });
    const pcm = Buffer.concat([region(1, 45), region(2, 45), region(3, 20)]);
    const result = await pipeline.finish([{ index: 0, data: pcm.toString("base64") }]);
    expect(result.segments).toBe(3);
    expect(peak).toBe(2); // parallel, but never above the ceiling
    expect(result.raw).toBe("s1 s2 s3");
    expect(result.rateLimit.requests).toBe(3);
  });
});

describe("voice on the coordinator", () => {
  // One key on the hub serves every host, which is the whole point of moving it
  // off the host: a Mac that has never had a provider key gets dictation.
  const fakeFetch = (transcript) => async (url) => {
    if (String(url).includes("/audio/transcriptions")) {
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ text: transcript }) };
    }
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ choices: [{ message: { content: "The PiNet coordinator is fast." } }] }),
    };
  };

  it("is disabled without a key, and says so", async () => {
    const { createVoiceService } = await import("../../src/coordinator/voice.mjs");
    const service = createVoiceService({ env: {} });
    expect(service.enabled).toBe(false);
    expect((await service.transcribe({ chunks: ["AAAA"] })).flags).toContain("voice_disabled");
  });

  it("turns captured audio into cleaned text", async () => {
    const { createVoiceService } = await import("../../src/coordinator/voice.mjs");
    const service = createVoiceService({
      env: { GROQ_API_KEY: "k" },
      fetchImpl: fakeFetch("um the pin net coordinator is fast"),
    });
    expect(service.enabled).toBe(true);
    expect(service.side).toBe("coordinator");
    const pcm = Buffer.alloc(SAMPLE_RATE_HZ * 2 * 2, 7).toString("base64");
    const result = await service.transcribe({ chunks: [pcm, pcm] });
    expect(result.text).toBe("The PiNet coordinator is fast.");
    expect(result.raw).toBe("um the pin net coordinator is fast");
    expect(result.flags).toEqual([]);
  });

  it("treats an empty take as nothing said", async () => {
    const { createVoiceService } = await import("../../src/coordinator/voice.mjs");
    const service = createVoiceService({ env: { GROQ_API_KEY: "k" }, fetchImpl: fakeFetch("x") });
    expect((await service.transcribe({ chunks: [] })).flags).toEqual(["no_speech"]);
  });
});

describe("voice: a model that talks instead of cleaning", () => {
  it("recovers the transcript when it was wrapped in an explanation", () => {
    // The reported failure, verbatim in shape: the model lectured about the
    // language and appended the text it had been asked to clean.
    const raw = "Aðaðaði nýjaði næstur að náðan af hanaði landaði peníburna þetta fela.";
    const clean = `The input text is not in English and does not contain recognizable English speech. According to Rule 8, if the transcript is empty or contains no meaningful speech (in the context of the specified language, English), it should be returned unchanged.\n\n${raw}`;
    expect(guardResult(raw, clean).reasons).toContain("meta");
    expect(extractTranscript(raw, clean)).toBe(raw);
  });

  it("does not claim a recovery when nothing was added", () => {
    const raw = "deploy the fix";
    expect(extractTranscript(raw, raw)).toBeUndefined();
    expect(extractTranscript(raw, "Something else entirely")).toBeUndefined();
    expect(extractTranscript("tiny", "tiny")).toBeUndefined();
  });

  it("flags reasoning about the task, not the word 'transcript' alone", () => {
    expect(guardResult("hello there", "The input is unclear, returning it unchanged").reasons).toContain("meta");
    expect(guardResult("hello there", "According to Rule 8 this needs no change").reasons).toContain("meta");
    // A cleaned transcript that happens to mention transcripts is fine.
    expect(guardResult("send me the transcript", "Send me the transcript.").reasons).toEqual([]);
  });

  it("keeps the cleanup prompt language-agnostic", () => {
    const prompt = buildCleanupPrompt();
    expect(prompt).not.toContain("spoken language (en)");
    expect(prompt).toMatch(/Work in the language that was spoken/);
    expect(prompt).toMatch(/never translate it/);
    expect(prompt).toMatch(/Output ONLY the resulting text/);
  });
});

describe("voice: hardening from adversarial review", () => {
  it("refuses a spool id that would escape the spool directory", async () => {
    // `retry` takes an id from a controller command, and `mark` writes.
    const { VoiceSpool } = await import("../../src/host/voice.mjs");
    expect(VoiceSpool.isSafeId("2026-09-28T00-00-00-000Z-0000-abcd")).toBe(true);
    expect(VoiceSpool.isSafeId("../../.pi/agent/auth")).toBe(false);
    expect(VoiceSpool.isSafeId("..%2f..%2fx")).toBe(false);
    expect(VoiceSpool.isSafeId("/etc/passwd")).toBe(false);
    expect(VoiceSpool.isSafeId("a/b")).toBe(false);
    expect(VoiceSpool.isSafeId("")).toBe(false);
    expect(VoiceSpool.isSafeId(undefined)).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "pinet-spool-id-"));
    const spool = new VoiceSpool({ dir });
    expect(() => spool.load("../../etc/passwd")).toThrow(VoiceError);
    spool.mark("../../etc/passwd", { status: "ok" }); // must not throw, must not write
    expect(() => spool.load("nope")).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("clamps an absurd retry-after instead of stalling forever", async () => {
    const { RateLimiter } = await import("../../src/host/voice.mjs");
    const limiter = new RateLimiter({ concurrency: 4 });
    limiter.observe({ status: 429, headers: { get: () => "999999" } });
    // Gate is capped at a minute, not 11 days.
    expect(limiter.gateUntil - limiter.now()).toBeLessThanOrEqual(60_000);
  });

  it("refuses a take that is not 16kHz rather than mis-wrapping it", async () => {
    const { createVoiceService } = await import("../../src/coordinator/voice.mjs");
    const service = createVoiceService({ env: { GROQ_API_KEY: "k" }, fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ text: "x" }) }) });
    await expect(service.transcribe({ chunks: ["AAAA"], sampleRate: 8000 })).rejects.toMatchObject({ code: "unsupported_sample_rate" });
  });

  it("splits daemon arguments on the first = only", async () => {
    const { parseArgs } = await import("../../src/spawner/daemon.mjs");
    expect(parseArgs(["--dir", "/tmp", "--label", "a=b"])).toMatchObject({ dir: "/tmp", label: "a=b" });
    expect(parseArgs(["--dir=/tmp", "--label=a=b"])).toMatchObject({ dir: "/tmp", label: "a=b" });
  });
});
