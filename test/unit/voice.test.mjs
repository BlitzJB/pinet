import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICIES,
  MAX_AUDIO_BYTES,
  VoiceError,
  VoicePipeline,
  assembleChunks,
  buildCleanupPrompt,
  guardResult,
  hotwordHint,
  pcm16ToWav,
  resolveApiKey,
} from "../../src/host/voice.mjs";

const pcm = (samples) => Buffer.from(Int16Array.from(samples).buffer);
const b64 = (buf) => Buffer.from(buf).toString("base64");

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

  it("refuses an utterance beyond the cap", () => {
    const huge = Buffer.alloc(MAX_AUDIO_BYTES + 2).toString("base64");
    expect(() => assembleChunks([{ index: 0, data: huge }])).toThrow(VoiceError);
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
