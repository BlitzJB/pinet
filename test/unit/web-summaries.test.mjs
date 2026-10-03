import { describe, expect, it } from "vitest";
import { lastExchange } from "../../web/src/lib/summaries.ts";
import { cleanSummary, SUMMARY_MAX_CHARS } from "../../src/coordinator/summary.mjs";

describe("run summaries: picking the exchange", () => {
  it("takes the last assistant reply that has text, and the user turn before it", () => {
    const entries = [
      { id: "u1", kind: "user", text: "first ask" },
      { id: "a1", kind: "assistant", text: "first answer" },
      { id: "t1", kind: "tool", text: "output" },
      { id: "u2", kind: "user", text: "second ask" },
      { id: "a2", kind: "assistant", text: "second answer" },
    ];
    expect(lastExchange(entries)).toEqual({ at: "a2", user: "second ask", assistant: "second answer" });
  });

  it("ignores an assistant entry with no text, and a local echo with no id", () => {
    const entries = [
      { id: "u1", kind: "user", text: "ask" },
      { id: "a1", kind: "assistant", text: "answer" },
      { kind: "user", text: "an optimistic echo, no id yet" },
      { id: "a2", kind: "assistant", text: "   " },
    ];
    expect(lastExchange(entries)).toEqual({ at: "a1", user: "ask", assistant: "answer" });
  });

  it("returns nothing when there is no reply yet", () => {
    expect(lastExchange([{ id: "u1", kind: "user", text: "ask" }])).toBeUndefined();
    expect(lastExchange([])).toBeUndefined();
    expect(lastExchange(undefined)).toBeUndefined();
  });
});

describe("run summaries: tidying the model's line", () => {
  it("strips quotes, markdown and a trailing period", () => {
    expect(cleanSummary('"Added voice dictation."')).toBe("Added voice dictation");
    expect(cleanSummary("**Fixed the spawn scope check**.")).toBe("Fixed the spawn scope check");
    expect(cleanSummary("- Ran the test suite")).toBe("Ran the test suite");
  });

  it("keeps only the first line, and caps the length", () => {
    expect(cleanSummary("Did the thing\nAnd then explained it")).toBe("Did the thing");
    const long = cleanSummary("x".repeat(300));
    expect(long.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns empty for empty input rather than inventing something", () => {
    expect(cleanSummary("")).toBe("");
    expect(cleanSummary(undefined)).toBe("");
    expect(cleanSummary("   \n  ")).toBe("");
  });
});
