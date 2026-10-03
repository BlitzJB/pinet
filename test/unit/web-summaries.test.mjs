import { describe, expect, it } from "vitest";
import { isRunComplete, isSettled, lastExchange, parseSummary, pushSummary, SUMMARY_QUIET_MS } from "../../web/src/lib/summaries.ts";
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
    // The prompt is the turn before *that* reply, not the echo that follows it.
    expect(lastExchange(entries)).toEqual({ at: "a1", user: "ask", assistant: "answer" });
  });

  it("returns nothing when there is no reply yet", () => {
    expect(lastExchange([{ id: "u1", kind: "user", text: "ask" }])).toBeUndefined();
    expect(lastExchange([])).toBeUndefined();
    expect(lastExchange(undefined)).toBeUndefined();
  });
});

describe("run summaries: tidying the model's line", () => {
  it("strips quotes, markdown and bullets", () => {
    expect(cleanSummary('"Added voice dictation."')).toBe("Added voice dictation");
    expect(cleanSummary("**Fixed the spawn scope check**.")).toBe("Fixed the spawn scope check");
    expect(cleanSummary("- **Waiting** — which provider should the summariser use?")).toBe(
      "Waiting — which provider should the summariser use?",
    );
    expect(cleanSummary("1. Done — added the status board")).toBe("Done — added the status board");
  });

  it("keeps up to six lines, and caps each line", () => {
    expect(cleanSummary("Done — fixed the spawn scope check\nStill to do: the picker")).toBe(
      "Done — fixed the spawn scope check\nStill to do: the picker",
    );
    expect(cleanSummary("one\ntwo\nthree\nfour\nfive").split("\n")).toHaveLength(5);
    expect(cleanSummary("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight").split("\n")).toHaveLength(6);
    const long = cleanSummary("x".repeat(300));
    expect(long.split("\n")[0].length).toBeLessThanOrEqual(SUMMARY_MAX_LINE_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns empty for empty input rather than inventing something", () => {
    expect(cleanSummary("")).toBe("");
    expect(cleanSummary(undefined)).toBe("");
    expect(cleanSummary("   \n  ")).toBe("");
  });
});

describe("run summaries: labels become badges", () => {
  it("gives each label its own piece, with the text that belongs to it", () => {
    expect(parseSummary("Waiting — which provider should the summariser use?")).toEqual({
      items: [{ label: "Waiting", text: "which provider should the summariser use?" }],
    });
    // The shape the model actually produced: a label on its own line, then content,
    // then another label opening a new sentence mid-line.
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

  it("keeps every label when there are several", () => {
    expect(parseSummary("Waiting\nneeds a decision\nBlocked\nthe image is missing")).toEqual({
      items: [
        { label: "Waiting", text: "needs a decision" },
        { label: "Blocked", text: "the image is missing" },
      ],
    });
    expect(parseSummary("Answered — the fix is Done")).toEqual({
      items: [{ label: "Answered", text: "the fix is Done" }],
    });
  });
});

describe("run summaries: history", () => {
  it("keeps the newest first, one per run, capped", () => {
    let list = pushSummary(undefined, { at: "a1", text: "first" });
    list = pushSummary(list, { at: "a2", text: "second" });
    expect(list.map((entry) => entry.at)).toEqual(["a2", "a1"]);
    list = pushSummary(list, { at: "a1", text: "first, rewritten" });
    expect(list.map((entry) => entry.at)).toEqual(["a1", "a2"]);
    expect(list[0].text).toBe("first, rewritten");
    const many = ["a", "b", "c", "d", "e", "f"].reduce((acc, id) => pushSummary(acc, { at: id, text: id }), []);
    expect(many).toHaveLength(5);
  });
});

describe("run summaries: knowing the run is finished", () => {
  const entriesAt = (ms) => [{ kind: "assistant", id: "a1", text: "x", timestamp: ms }];

  it("is complete as soon as the host says the agent settled", () => {
    const now = 1_000_000;
    expect(isRunComplete({ running: false, settledAt: now, entries: entriesAt(now - 500) }, 180_000, now)).toBe(true);
    expect(isRunComplete({ running: false, settledAt: now, entries: entriesAt(now - 1) }, 180_000, now)).toBe(true);
    expect(isRunComplete({ running: true, settledAt: now, entries: entriesAt(now - 500) }, 180_000, now)).toBe(false);
    // Settled before the newest entry means more work happened afterwards.
    expect(isRunComplete({ running: false, settledAt: now - 5_000, entries: entriesAt(now) }, 180_000, now)).toBe(false);
  });

  it("falls back to a quiet period for a host that does not report it", () => {
    const now = 1_000_000;
    expect(isRunComplete({ running: false, settledAt: null, entries: entriesAt(now - 10) }, 180_000, now)).toBe(false);
    expect(isRunComplete({ running: false, settledAt: null, entries: entriesAt(now - 200_000) }, 180_000, now)).toBe(true);
    expect(isSettled(entriesAt(now - SUMMARY_QUIET_MS), SUMMARY_QUIET_MS, now)).toBe(true);
    expect(isSettled(entriesAt(now), SUMMARY_QUIET_MS, now)).toBe(false);
  });
});

describe("run summaries: a dangling label", () => {
  it("is dropped when there is other content, kept when it is all there is", async () => {
    const { parseSummary } = await import("../../web/src/lib/summaries.ts");
    // The model stopped after the label: no content to put under it.
    expect(parseSummary("Done\nfixed the picker\nWaiting")).toEqual({
      items: [{ label: "Done", text: "fixed the picker" }],
    });
    // Nothing else to show, so the badge still says something useful.
    expect(parseSummary("Waiting")).toEqual({ items: [{ label: "Waiting", text: "" }] });
  });
});

describe("run summaries: the log", () => {
  it("records what was asked and what came back, without the text by default", async () => {
    const { createSummaryService } = await import("../../src/coordinator/summary.mjs");
    const records = [];
    const service = createSummaryService({
      env: { GROQ_API_KEY: "k" },
      log: (record) => records.push(record),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ choices: [{ message: { content: "Done — badge parser splits mid-sentence labels" } }] }),
      }),
    });
    const result = await service.summarise({ user: "did you fix it?", assistant: "yes, here is how" });
    expect(result.summary).toBe("Done — badge parser splits mid-sentence labels");
    expect(records).toHaveLength(1);
    const [entry] = records;
    expect(entry).toMatchObject({ kind: "summary", model: "qwen/qwen3.8-27b", status: 200 });
    expect(entry.raw).toContain("Done —");
    expect(entry.summary).toBe(result.summary);
    expect(entry.userChars).toBe(15);
    expect(entry.hash).toHaveLength(12);
    // Session content is not written to a file on the hub unless asked for.
    expect(entry.input).toBeUndefined();
  });

  it("logs a failed call too, since that is what you want to see", async () => {
    const { createSummaryService } = await import("../../src/coordinator/summary.mjs");
    const records = [];
    const service = createSummaryService({
      env: { GROQ_API_KEY: "k" },
      log: (record) => records.push(record),
      fetchImpl: async () => ({ ok: false, status: 429, headers: new Map(), text: async () => "slow down" }),
    });
    await expect(service.summarise({ user: "a", assistant: "b" })).rejects.toThrow();
    expect(records[0]).toMatchObject({ kind: "summary", status: 429, error: "http" });
  });

  it("writes one JSON line per call, and rotates past the cap", async () => {
    const { createSummaryLog } = await import("../../src/coordinator/summary.mjs");
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pinet-summary-log-"));
    const path = join(dir, "nested", "summaries.jsonl");
    const log = createSummaryLog({ path, maxBytes: 200 });
    for (let i = 0; i < 6; i += 1) log({ kind: "summary", summary: `line ${i}`, raw: `line ${i}` });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThan(6);
    expect(JSON.parse(lines[0]).at).toBeTruthy();
    // The previous file is kept once, so nothing is silently lost.
    expect(readFileSync(`${path}.1`, "utf8").length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("run summaries: the model is not cut off", () => {
  it("asks for a generous budget, without saying so in the prompt", async () => {
    const { createSummaryService } = await import("../../src/coordinator/summary.mjs");
    let sent;
    const service = createSummaryService({
      env: { GROQ_API_KEY: "k" },
      log: () => {},
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "Done — ok" } }] }) };
      },
    });
    await service.summarise({ user: "a", assistant: "b" });
    // Room to finish a thought: 64 tokens truncated the output mid-sentence.
    expect(sent.max_tokens).toBe(500);
    // But the model is not told it has that much room, or it fills it.
    expect(sent.messages[0].content).not.toMatch(/\b\d{3}\b/);
  });
});
