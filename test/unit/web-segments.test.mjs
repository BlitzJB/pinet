import { describe, expect, it } from "vitest";
import { segmentAssistantTurn, summarizeActivity } from "../../web/src/lib/segments.ts";

const assistant = (id, fields) => ({ id, kind: "assistant", ...fields });
const toolResult = (id, toolCallId, text, timestamp) => ({ id, kind: "tool", toolCallId, text, timestamp });

describe("segmentAssistantTurn", () => {
  it("collapses consecutive reasoning + tool blocks into one activity, then text", () => {
    const segments = segmentAssistantTurn([
      assistant("a1", { reasoning: "r1", tools: [{ id: "t1", name: "bash", args: '{"command":"ls"}' }], timestamp: 1000 }),
      toolResult("tr1", "t1", "out1", 1500),
      assistant("a2", { reasoning: "r2", tools: [{ id: "t2", name: "read" }], timestamp: 2000 }),
      toolResult("tr2", "t2", "out2", 2500),
      assistant("a3", { text: "Final answer", timestamp: 3000 }),
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual(["activity", "text"]);
    const activity = segments[0];
    expect(activity.items).toHaveLength(4); // reasoning, tool, reasoning, tool
    expect(segments[1]).toEqual({ kind: "text", text: "Final answer" });

    const tool = activity.items.find((item) => item.type === "tool");
    expect(tool.output).toBe("out1");
    expect(tool.running).toBe(false);
    expect(tool.durationMs).toBe(500);
  });

  it("keeps a lone reasoning block in its own activity", () => {
    const segments = segmentAssistantTurn([assistant("a1", { reasoning: "just thinking" })]);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("activity");
    expect(segments[0].items).toHaveLength(1);
  });

  it("marks a tool without a result as running", () => {
    const segments = segmentAssistantTurn([assistant("a1", { tools: [{ id: "t1", name: "bash" }] })]);
    const tool = segments[0].items[0];
    expect(tool.running).toBe(true);
  });
});

describe("summarizeActivity", () => {
  it("summarizes tools and reasoning", () => {
    expect(summarizeActivity([{ type: "reasoning", text: "x" }, { type: "tool", name: "bash" }]).label).toContain("Thought");
    expect(summarizeActivity([{ type: "tool", name: "bash" }, { type: "tool", name: "read" }]).label).toContain("bash");
    expect(summarizeActivity([{ type: "reasoning", text: "x" }]).label).toBe("Thought");
  });

  it("sums tool durations", () => {
    expect(summarizeActivity([{ type: "tool", name: "a", durationMs: 400 }, { type: "tool", name: "b", durationMs: 1100 }]).totalMs).toBe(1500);
  });
});
