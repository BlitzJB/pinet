import { describe, expect, it } from "vitest";
import {
  describeTool,
  diffLines,
  lineCount,
  parseToolArgs,
  splitPath,
  summarizeDiff,
  summarizeTools,
  truncateLines,
} from "../../web/src/lib/tools.ts";

describe("tool args", () => {
  it("parses what a tool actually sends, and shrugs at what it cannot", () => {
    expect(parseToolArgs('{"path":"src/a.mjs"}')).toEqual({ path: "src/a.mjs" });
    expect(parseToolArgs("src/a.mjs")).toBeUndefined();
    expect(parseToolArgs("[1,2]")).toBeUndefined();
    expect(parseToolArgs("{not json")).toBeUndefined();
    expect(parseToolArgs("")).toBeUndefined();
    expect(parseToolArgs(undefined)).toBeUndefined();
  });
});

describe("describing a tool call", () => {
  it("reads a file call as a sentence", () => {
    const view = describeTool("read", '{"path":"/root/pinet/src/host/commands.mjs"}', "one\ntwo\nthree");
    expect(view).toMatchObject({ kind: "read", verb: "Read", target: "/root/pinet/src/host/commands.mjs", detail: "3 lines" });
  });

  it("turns an edit into a diff with counts", () => {
    const view = describeTool("edit", '{"path":"a.mjs","oldText":"const a = 1;","newText":"const a = 2;"}', "");
    expect(view.kind).toBe("edit");
    expect(view.target).toBe("a.mjs");
    expect(view.additions).toBe(1);
    expect(view.deletions).toBe(1);
    expect(view.diff?.some((line) => line.kind === "add" && line.text === "const a = 2;")).toBe(true);
    expect(view.diff?.some((line) => line.kind === "remove" && line.text === "const a = 1;")).toBe(true);
  });

  it("handles an edit that carries several changes", () => {
    const args = JSON.stringify({
      path: "a.mjs",
      edits: [
        { oldText: "one", newText: "ONE" },
        { oldText: "two", newText: "TWO" },
      ],
    });
    const view = describeTool("edit", args, "");
    expect(view.additions).toBe(2);
    expect(view.deletions).toBe(2);
  });

  it("shows a write as all additions", () => {
    const view = describeTool("write", '{"path":"new.mjs","content":"a\\nb\\nc"}', "");
    expect(view).toMatchObject({ kind: "write", verb: "Wrote", additions: 3, deletions: 0, detail: "3 lines" });
  });

  it("keeps a command on one line and finds the exit code", () => {
    const view = describeTool("bash", '{"command":"npm test\\n&& echo done"}', "boom\n\nProcess exited with exit code 1");
    expect(view.kind).toBe("bash");
    expect(view.target).toBe("npm test");
    expect(view.detail).toBe("exit 1");
  });

  it("counts matches, and says so when there are none", () => {
    expect(describeTool("grep", '{"pattern":"useEffect"}', "a\nb").detail).toBe("2 matches");
    expect(describeTool("grep", '{"pattern":"useEffect"}', "").detail).toBe("no matches");
    expect(describeTool("grep", '{"pattern":"x"}', "a").target).toBe('"x"');
  });

  it("never throws, whatever it is handed", () => {
    for (const name of ["", "read", "edit", "bash", "unknown-tool", "subagent"]) {
      expect(() => describeTool(name, "{broken", undefined)).not.toThrow();
    }
    expect(describeTool("mystery", '{"alpha":"beta"}', "").target).toBe("beta");
    expect(describeTool("", "", "").verb).toBe("Tool");
  });
});

describe("diffing", () => {
  it("marks a changed line and keeps the context around it", () => {
    const lines = diffLines("a\nb\nc", "a\nB\nc");
    expect(lines.map((line) => line.kind)).toEqual(["context", "remove", "add", "context"]);
    expect(lines.find((line) => line.kind === "remove")).toMatchObject({ text: "b", oldLine: 2 });
    expect(lines.find((line) => line.kind === "add")).toMatchObject({ text: "B", newLine: 2 });
  });

  it("reports additions and deletions separately", () => {
    expect(summarizeDiff(diffLines("a", "a\nb\nc"))).toEqual({ additions: 2, deletions: 0 });
    expect(summarizeDiff(diffLines("a\nb\nc", "a"))).toEqual({ additions: 0, deletions: 2 });
    expect(summarizeDiff(diffLines("same", "same"))).toEqual({ additions: 0, deletions: 0 });
  });

  it("collapses untouched stretches rather than printing a whole file", () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 30", "changed");
    const lines = diffLines(before, after);
    expect(lines[0].kind).toBe("gap");
    expect(lines.at(-1)?.kind).toBe("gap");
    // Context either side plus the change, not sixty lines.
    expect(lines.length).toBeLessThan(12);
  });

  it("falls back to a replacement when the two sides are huge and unrelated", () => {
    const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n");
    const lines = diffLines(before, after);
    expect(lines.filter((line) => line.kind === "remove")).toHaveLength(500);
    expect(lines.filter((line) => line.kind === "add")).toHaveLength(500);
  });
});

describe("group summary", () => {
  it("says what happened the way a person would", () => {
    const reads = [1, 2, 3, 4].map(() => describeTool("read", '{"path":"a"}', "x"));
    const runs = [1, 2].map(() => describeTool("bash", '{"command":"ls"}', ""));
    expect(summarizeTools([...reads, ...runs])).toBe("4 files and 2 commands");
    expect(summarizeTools(reads.slice(0, 1))).toBe("1 file");
    expect(summarizeTools([...reads, ...runs, describeTool("grep", "{}", "")])).toBe("4 files, 2 commands and 1 search");
    expect(summarizeTools([])).toBe("Activity");
  });
});

describe("display helpers", () => {
  it("splits a path so the file name stays legible", () => {
    expect(splitPath("/root/pinet/src/host/commands.mjs")).toEqual({ dir: "/root/pinet/src/host/", base: "commands.mjs" });
    expect(splitPath("package.json")).toEqual({ dir: "", base: "package.json" });
  });

  it("caps long output and says how much was hidden", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(truncateLines(text, 10)).toMatchObject({ hidden: 30, total: 40 });
    expect(truncateLines(text, 100)).toMatchObject({ hidden: 0, total: 40 });
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\n\nb")).toBe(2);
  });
});
