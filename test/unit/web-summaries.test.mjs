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

  it("gives each label its own piece, with the text that belongs to it", async () => {
    const { parseSummary } = await import("../../web/src/lib/summaries.ts");
    expect(parseSummary("Waiting — which provider should the summariser use?")).toEqual({
      items: [{ label: "Waiting", text: "which provider should the summariser use?" }],
    });
    // The shape the model actually produced in the report: a label on its own line,
    // then content, then another label mid-sentence.
    expect(
      parseSummary("Done\nagent completion polling now runs every 60s while active. Waiting — host restart in progress"),
    ).toEqual({
      items: [
        { label: "Done", text: "agent completion polling now runs every 60s while active." },
        { label: "Waiting", text: "host restart in progress" },
      ],
    });
    // A line with no label continues the piece above it.
    expect(parseSummary("Done\nfixed the picker\nand the scope check")).toEqual({
      items: [{ label: "Done", text: "fixed the picker and the scope check" }],
    });
    expect(parseSummary("Something else entirely")).toEqual({ items: [{ text: "Something else entirely" }] });
    expect(parseSummary(undefined)).toEqual({ items: [] });
  });

  it("keeps every label when the model gives several", async () => {
    const { parseSummary } = await import("../../web/src/lib/summaries.ts");
    expect(parseSummary("Waiting\nneeds a decision\nBlocked\nthe image is missing")).toEqual({
      items: [
        { label: "Waiting", text: "needs a decision" },
        { label: "Blocked", text: "the image is missing" },
      ],
    });
    expect(parseSummary("Answered — the fix is Done")).toEqual({ items: [{ label: "Answered", text: "the fix is Done" }] });
  });
    expect(parseSummary("Done / Waiting — shipped it, wants a review")).toEqual({
      labels: ["Done", "Waiting"],
      body: ["shipped it, wants a review"],
    });
    // A label mentioned later in the sentence is body text, not a label.
    expect(parseSummary("Answered — the fix is Done")).toEqual({ labels: ["Answered"], body: ["the fix is Done"] });
    // Repeats collapse rather than rendering twice.
    expect(parseSummary("Done, Done — twice")).toEqual({ labels: ["Done"], body: ["twice"] });
  });
});

describe("run summaries: only once the session is done", () => {
  it("waits for a quiet period, so a multi-turn task costs one call", async () => {
    const { isSettled, SUMMARY_QUIET_MS } = await import("../../web/src/lib/summaries.ts");
    const now = 1_000_000_000;
    const entry = (agoMs) => [{ kind: "assistant", id: "a1", text: "x", timestamp: now - agoMs }];
    // Just finished a turn: not settled, so nothing is generated yet.
    expect(isSettled(entry(0), SUMMARY_QUIET_MS, now)).toBe(false);
    expect(isSettled(entry(SUMMARY_QUIET_MS - 1), SUMMARY_QUIET_MS, now)).toBe(false);
    // Quiet for the full period: now it is worth one line.
    expect(isSettled(entry(SUMMARY_QUIET_MS), SUMMARY_QUIET_MS, now)).toBe(true);
    expect(isSettled(entry(60 * 60_000), SUMMARY_QUIET_MS, now)).toBe(true);
    // No timestamp to reason about: do not hold the line back.
    expect(isSettled([{ kind: "assistant", id: "a1", text: "x" }], SUMMARY_QUIET_MS, now)).toBe(true);
    expect(isSettled([], SUMMARY_QUIET_MS, now)).toBe(true);
  });
});

describe("run summaries: the settle signal beats waiting", () => {
  const entriesAt = (ms) => [{ kind: "assistant", id: "a1", text: "x", timestamp: ms }];

  it("is complete as soon as the host says the agent settled", async () => {
    const { isRunComplete } = await import("../../web/src/lib/summaries.ts");
    const now = 1_000_000;
    // Settled after the last entry: finished, no waiting required.
    expect(isRunComplete({ running: false, settledAt: now, entries: entriesAt(now - 500) }, 180_000, now)).toBe(true);
    expect(isRunComplete({ running: false, settledAt: now, entries: entriesAt(now - 1) }, 180_000, now)).toBe(true);
    // Still running: never.
    expect(isRunComplete({ running: true, settledAt: now, entries: entriesAt(now - 500) }, 180_000, now)).toBe(false);
    // Settled *before* the newest entry means more work happened afterwards.
    expect(isRunComplete({ running: false, settledAt: now - 5_000, entries: entriesAt(now) }, 180_000, now)).toBe(false);
  });

  it("falls back to the quiet period for a host that does not report it", async () => {
    const { isRunComplete } = await import("../../web/src/lib/summaries.ts");
    const now = 1_000_000;
    expect(isRunComplete({ running: false, settledAt: null, entries: entriesAt(now - 10) }, 180_000, now)).toBe(false);
    expect(isRunComplete({ running: false, settledAt: null, entries: entriesAt(now - 200_000) }, 180_000, now)).toBe(true);
  });
});
