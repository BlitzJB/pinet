import { describe, expect, it } from "vitest";
import { lastExchange } from "../../web/src/lib/summaries.ts";
import { cleanSummary, SUMMARY_MAX_LINE_CHARS } from "../../src/coordinator/summary.mjs";

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

  it("keeps up to three lines, and caps each line", () => {
    expect(cleanSummary("Done — fixed the spawn scope check\nStill to do: the picker")).toBe(
      "Done — fixed the spawn scope check\nStill to do: the picker",
    );
    const many = cleanSummary("one\ntwo\nthree\nfour\nfive");
    expect(many.split("\n")).toHaveLength(3);
    const long = cleanSummary("x".repeat(300));
    expect(long.split("\n")[0].length).toBeLessThanOrEqual(SUMMARY_MAX_LINE_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("strips bullets, bold and numbering but keeps the label", () => {
    // The question mark is kept: on a "Waiting" line it is the whole point.
    expect(cleanSummary("- **Waiting** — which provider should the summariser use?")).toBe(
      "Waiting — which provider should the summariser use?",
    );
    expect(cleanSummary("1. Done — added the status board")).toBe("Done — added the status board");
  });

  it("returns empty for empty input rather than inventing something", () => {
    expect(cleanSummary("")).toBe("");
    expect(cleanSummary(undefined)).toBe("");
    expect(cleanSummary("   \n  ")).toBe("");
  });
});

describe("run summaries: history and labels", () => {
  it("keeps the newest first, one per run, capped", async () => {
    const { pushSummary } = await import("../../web/src/lib/summaries.ts");
    let list = pushSummary(undefined, { at: "a1", text: "first" });
    list = pushSummary(list, { at: "a2", text: "second" });
    expect(list.map((entry) => entry.at)).toEqual(["a2", "a1"]);
    // Re-summarising the same run replaces rather than duplicates.
    list = pushSummary(list, { at: "a1", text: "first, rewritten" });
    expect(list.map((entry) => entry.at)).toEqual(["a1", "a2"]);
    expect(list[0].text).toBe("first, rewritten");
    const many = ["a", "b", "c", "d", "e", "f"].reduce((acc, id) => pushSummary(acc, { at: id, text: id }), []);
    expect(many).toHaveLength(5);
  });

  it("splits the label off, so the list can show whether it needs you", async () => {
    const { parseSummary } = await import("../../web/src/lib/summaries.ts");
    expect(parseSummary("Waiting — which provider should the summariser use?")).toEqual({
      label: "Waiting",
      body: ["which provider should the summariser use?"],
    });
    expect(parseSummary("Done — fixed the spawn scope check\nStill to do: the picker")).toEqual({
      label: "Done",
      body: ["fixed the spawn scope check", "Still to do: the picker"],
    });
    expect(parseSummary("No changes - investigated the timeout")).toEqual({ label: "No changes", body: ["investigated the timeout"] });
    // Unlabelled text is shown as-is rather than guessed at.
    expect(parseSummary("Something else entirely")).toEqual({ label: undefined, body: ["Something else entirely"] });
    expect(parseSummary(undefined)).toEqual({ body: [] });
  });
});
