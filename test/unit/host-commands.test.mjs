import { describe, expect, it } from "vitest";
import {
  commandCatalogue,
  filterPaths,
  parseCommand,
  resolveCommand,
  walkFiles,
  DEFAULT_IGNORES,
} from "../../src/host/commands.mjs";

describe("slash commands: parsing", () => {
  it("reads a name and its arguments", () => {
    expect(parseCommand("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseCommand("/compact focus on the parser")).toEqual({ name: "compact", args: "focus on the parser" });
    expect(parseCommand("/skill:review please")).toEqual({ name: "skill:review", args: "please" });
    expect(parseCommand("  /name My Session  ")).toEqual({ name: "name", args: "My Session" });
  });

  it("is not fooled by things that only look like commands", () => {
    expect(parseCommand("hello /compact")).toBeUndefined();
    expect(parseCommand("/")).toBeUndefined();
    expect(parseCommand("/ leading space")).toBeUndefined();
    expect(parseCommand("")).toBeUndefined();
    expect(parseCommand(undefined)).toBeUndefined();
  });
});

describe("slash commands: what gets intercepted", () => {
  const commands = [{ name: "review", description: "Review the diff", source: "prompt" }];

  it("sends the ones the portal can run to the session APIs", () => {
    expect(resolveCommand("/compact focus on the parser", { commands })).toMatchObject({
      kind: "portal", name: "compact", args: "focus on the parser",
    });
    expect(resolveCommand("/name Refactor", { commands })).toMatchObject({ kind: "portal", name: "name", args: "Refactor" });
  });

  it("passes templates, skills and extension commands straight through to pi", () => {
    // pi's prompt() expands these itself, so the portal does not touch the text.
    expect(resolveCommand("/review the last commit", { commands })).toMatchObject({ kind: "passthrough", name: "review" });
    expect(resolveCommand("/skill:review", { commands: [{ name: "skill:review", source: "skill" }] })).toMatchObject({
      kind: "passthrough",
    });
  });

  it("refuses terminal-only commands rather than swallowing them", () => {
    expect(resolveCommand("/tree", { commands })).toMatchObject({ kind: "tui-only", name: "tree" });
    expect(resolveCommand("/quit", { commands })).toMatchObject({ kind: "tui-only", name: "quit" });
  });

  it("leaves a path and an unknown command to the agent", () => {
    // A path that starts with a slash must keep working as ordinary text.
    expect(resolveCommand("/root/pinet what is here?", { commands })).toEqual({ kind: "none", text: "/root/pinet what is here?" });
    expect(resolveCommand("/notacommand", { commands })).toEqual({ kind: "none", text: "/notacommand" });
    expect(resolveCommand("just a message", { commands })).toEqual({ kind: "none", text: "just a message" });
  });

  it("lets a portal built-in shadow an extension of the same name", () => {
    // pi itself refuses that collision, so the built-in is the one that can run.
    expect(resolveCommand("/model x", { commands: [{ name: "model", source: "extension" }] })).toMatchObject({ kind: "portal" });
  });
});

describe("slash commands: the catalogue", () => {
  it("merges built-ins, session commands and terminal-only ones, once each", () => {
    const list = commandCatalogue({
      commands: [
        { name: "review", description: "Review the diff", argumentHint: "<ref>", source: "prompt" },
        { name: "compact", description: "an extension trying to shadow a built-in", source: "extension" },
      ],
    });
    const names = list.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("review");
    expect(names).toContain("tree");
    expect(names.filter((name) => name === "compact")).toHaveLength(1);
    expect(list.find((command) => command.name === "compact").source).toBe("builtin");
    expect(list.find((command) => command.name === "review")).toMatchObject({ description: "Review the diff", argumentHint: "<ref>" });
    expect(list.find((command) => command.name === "tree")).toMatchObject({ source: "tui", description: "Terminal only" });
  });

  it("survives a command with no name", () => {
    expect(commandCatalogue({ commands: [{ description: "nameless" }, null, { name: "ok" }] }).some((c) => c.name === "ok")).toBe(true);
  });
});

describe("file mentions: ranking", () => {
  const paths = ["package.json", "src/host/commands.mjs", "src/host/voice.mjs", "web/src/lib/pinet.ts", "README.md"];

  it("puts the exact basename first, then basename prefixes, then the rest", () => {
    expect(filterPaths(paths, "package.json")[0]).toBe("package.json");
    expect(filterPaths(paths, "com")[0]).toBe("src/host/commands.mjs");
    expect(filterPaths(paths, "src/host")[0]).toBe("src/host/commands.mjs");
    expect(filterPaths(paths, "pinet")).toEqual(["web/src/lib/pinet.ts"]);
  });

  it("prefers the shallower path when two match equally", () => {
    expect(filterPaths(["a/b/deep/notes.md", "notes.md"], "notes")[0]).toBe("notes.md");
  });

  it("returns something to start from, and respects the limit", () => {
    expect(filterPaths(paths, "")).toHaveLength(paths.length);
    expect(filterPaths(paths, "", 2)).toHaveLength(2);
    expect(filterPaths(paths, "nothing-matches-this")).toEqual([]);
  });
});

describe("file mentions: walking the session directory", () => {
  it("lists files relative to the root and skips the noise", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "pinet-walk-"));
    writeFileSync(join(root, "top.mjs"), "");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "inner.mjs"), "");
    for (const ignored of DEFAULT_IGNORES) {
      mkdirSync(join(root, ignored));
      writeFileSync(join(root, ignored, "hidden.mjs"), "");
    }
    const files = walkFiles(root);
    expect(files).toContain("top.mjs");
    expect(files).toContain("src/inner.mjs");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(files.some((file) => file.includes(".git"))).toBe(false);
    // Bounded, so a huge tree cannot stall the host.
    expect(walkFiles(root, { max: 1 })).toHaveLength(1);
    expect(walkFiles(join(root, "does-not-exist"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
