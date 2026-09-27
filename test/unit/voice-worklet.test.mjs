import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const worklet = read("../../web/public/voice-worklet.js");
const voice = read("../../web/src/lib/voice.ts");
const http = read("../../src/coordinator/http.mjs");

describe("voice capture worklet", () => {
  it("registers the processor the recorder instantiates", () => {
    expect(worklet).toContain('registerProcessor("pinet-capture"');
    expect(voice).toContain('new AudioWorkletNode(context, "pinet-capture")');
  });

  it("is loaded from a same-origin file, never a Blob URL", () => {
    // The app sends `worker-src 'self'`, which blocks blob: worklets — and the
    // failure is silent, so the mic button simply did nothing at all. This is
    // the regression guard for that: same-origin file only.
    expect(voice).toContain("voice-worklet.js");
    expect(voice).not.toMatch(/createObjectURL\(\s*new Blob/);
    expect(voice).toContain("addModule(WORKLET_URL)");
  });

  it("resolves the worklet against the app base, not the current route", () => {
    // The page lives at /app/s/<id>, so a relative URL would 404.
    expect(voice).toMatch(/WORKLET_URL = `\$\{import\.meta\.env\.BASE_URL\}voice-worklet\.js`/);
  });

  it("allows the microphone for this origin, so our own header cannot block capture", () => {
    // `microphone=()` disallows the feature for *every* origin including this
    // one. The Permissions API then reports "denied" and getUserMedia fails
    // instantly without ever prompting — indistinguishable from a user or OS
    // block, and unaffected by any user setting. That is exactly what shipped.
    const header = http.match(/"permissions-policy":\s*"([^"]+)"/)?.[1] ?? "";
    expect(header).toContain("microphone=(self)");
    expect(header).not.toMatch(/microphone=\(\)/);
    // Everything else stays denied: the header still does its job.
    expect(header).toContain("camera=()");
    expect(header).toContain("geolocation=()");
  });

  it("keeps the CSP same-origin, so a Blob worklet stays impossible", () => {
    const csp = http.match(/default-src[^"]+/)?.[0] ?? "";
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toMatch(/worker-src[^;]*blob:/);
  });
});

describe("worklet and recorder agree on the message shape", () => {
  it("posts audio and peaks as named fields, and reads them back the same way", () => {
    // They are separate messages: audio ~4x/second (transferred), peaks ~20x
    // (plain). If one side changes shape, capture goes silent.
    expect(worklet).toContain("this.port.postMessage({ peaks:");
    expect(worklet).toContain("this.port.postMessage({ audio: merged }, [merged.buffer]);");
    expect(voice).toContain("message.peaks");
    expect(voice).toContain("message.audio");
  });
});

describe("waveform history", () => {
  it("keeps the newest peaks and caps the length", async () => {
    const { appendPeaks } = await import("../../web/src/lib/voice.ts");
    expect(appendPeaks([], [0.1, 0.2])).toEqual([0.1, 0.2]);
    expect(appendPeaks([0.1], [0.2, 0.3], 4)).toEqual([0.1, 0.2, 0.3]);
    expect(appendPeaks([1, 2, 3], [4, 5], 4)).toEqual([2, 3, 4, 5]);
    // A single burst longer than the window keeps only its tail.
    expect(appendPeaks([1], [2, 3, 4, 5, 6], 3)).toEqual([4, 5, 6]);
  });

  it("reports a short, human reason for a capture failure", async () => {
    const { micErrorMessage } = await import("../../web/src/lib/voice.ts");
    const named = (name) => Object.assign(new Error(name), { name });
    expect(micErrorMessage(named("NotAllowedError"))).toMatch(/blocked/);
    expect(micErrorMessage(named("NotFoundError"))).toMatch(/No microphone/);
    expect(micErrorMessage(named("NotReadableError"))).toMatch(/in use/);
    expect(micErrorMessage(new Error("boom"))).toMatch(/Could not start recording/);
  });
});
