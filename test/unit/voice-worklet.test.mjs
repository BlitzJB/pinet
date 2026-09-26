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

  it("keeps the CSP same-origin, so a Blob worklet stays impossible", () => {
    const csp = http.match(/default-src[^"]+/)?.[0] ?? "";
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toMatch(/worker-src[^;]*blob:/);
  });
});

describe("microphone failure classification", () => {
  it("distinguishes site block, OS block, and no-device", async () => {
    const { micErrorInfo } = await import("../../web/src/lib/voice.ts");
    const notAllowed = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    // A site block is a stored decision.
    expect(micErrorInfo(notAllowed, "denied").message).toMatch(/blocked the microphone for this site/);
    // Refused before any prompt could appear => the app/OS level, and the hint
    // must say so rather than sending the user to site settings again.
    const preePrompt = micErrorInfo(notAllowed, "prompt", 3);
    expect(preePrompt.message).toMatch(/system is blocking the browser/);
    expect(preePrompt.hint).toMatch(/quit the browser completely|Permissions|grant your browser/);
    // A slow refusal means a prompt was answered.
    expect(micErrorInfo(notAllowed, "prompt", 4000).message).toMatch(/outside the page/);
    expect(micErrorInfo(Object.assign(new Error("x"), { name: "NotFoundError" })).message).toMatch(/No microphone found/);
  });
});
