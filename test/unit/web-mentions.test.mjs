import { describe, expect, it } from "vitest";
import {
  activeToken,
  commandAtStart,
  commandItems,
  fileItems,
  filterCommands,
  replaceToken,
  shouldShowSheet,
} from "../../web/src/lib/mentions.ts";

describe("mentions: finding the token", () => {
  it("opens a command palette only at the very start of the message", () => {
    expect(activeToken("/com", 4)).toEqual({ kind: "command", query: "com", start: 0, end: 4 });
    // A slash in the middle is a path or a date, not a command.
    expect(activeToken("see src/lib/foo", 14)).toBeUndefined();
    expect(activeToken("on 3/4", 6)).toBeUndefined();
  });

  it("opens a mention anywhere, and closes it at a space", () => {
    expect(activeToken("look at @src/ho", 15)).toEqual({ kind: "mention", query: "src/ho", start: 8, end: 15 });
    expect(activeToken("look at @src/host ", 17)).toMatchObject({ kind: "mention", query: "src/host" });
    // A space closes it.
    expect(activeToken("look at @src/host ", 18)).toBeUndefined();
    expect(activeToken("email me@example.com", 20)).toMatchObject({ kind: "mention", query: "example.com" });
  });

  it("prefers whichever opened most recently", () => {
    // `@a/b` is a mention even though a slash is involved.
    expect(activeToken("@a/b", 4)).toMatchObject({ kind: "mention", query: "a/b" });
  });

  it("consumes the rest of the token, so accepting replaces all of it", () => {
    expect(activeToken("/compact rest of line", 8)).toEqual({ kind: "command", query: "compact", start: 0, end: 8 });
    // Once a space is typed the palette closes: that is the argument, not the name.
    expect(activeToken("/compact rest of line", 10)).toBeUndefined();
    // And it consumes the whole name, so accepting replaces all of it.
    expect(activeToken("/compact rest of line", 8).end).toBe(8);
  });
});

describe("mentions: accepting a suggestion", () => {
  it("puts the caret after what it inserted", () => {
    // A command palette only opens at the start, so that is where its token lives.
    const token = activeToken("/com now", 4);
    expect(replaceToken("/com now", token, "/compact ")).toEqual({ text: "/compact  now", caret: 9 });
  });

  it("keeps the text around the token", () => {
    const token = activeToken("@sr done", 3);
    expect(replaceToken("@sr done", token, "@src/host/commands.mjs ")).toEqual({
      text: "@src/host/commands.mjs  done",
      caret: 23,
    });
  });
});

describe("mentions: filtering commands", () => {
  const commands = [
    { name: "compact", description: "Compact the session context", source: "builtin" },
    { name: "review", description: "Review the diff", source: "prompt" },
    { name: "skill:review", description: "Deep review", source: "skill" },
    { name: "tree", description: "Terminal only", source: "tui" },
  ];

  it("ranks name prefixes above matches elsewhere", () => {
    expect(filterCommands(commands, "com").map((c) => c.name)).toEqual(["compact"]);
    expect(filterCommands(commands, "review").map((c) => c.name)).toEqual(["review", "skill:review"]);
    expect(filterCommands(commands, "rev").map((c) => c.name)).toEqual(["review", "skill:review"]);
  });

  it("shows everything for an empty query, and nothing for a miss", () => {
    expect(filterCommands(commands, "")).toHaveLength(4);
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });

  it("marks terminal-only commands so they can explain themselves", () => {
    const items = commandItems(commands, "");
    expect(items.find((item) => item.label === "/tree")?.disabled).toBe(true);
    expect(items.find((item) => item.label === "/compact")).toMatchObject({ insert: "/compact ", disabled: false });
    expect(items.find((item) => item.label === "/compact")?.hint).toBeFalsy();
  });

  it("inserts a mention with its @ and a trailing space", () => {
    expect(fileItems(["src/a.mjs"])[0]).toMatchObject({ insert: "@src/a.mjs ", label: "src/a.mjs" });
  });

  it("finds the command a finished message would run, for a local refusal", () => {
    expect(commandAtStart("/tree", commands)?.source).toBe("tui");
    expect(commandAtStart("/tree now", commands)?.source).toBe("tui");
    expect(commandAtStart("/compact keep the plan", commands)?.source).toBe("builtin");
    expect(commandAtStart("hello", commands)).toBeUndefined();
  });
});

describe("mentions: whether the sheet is shown", () => {
  it("stays up while the first results are still coming", () => {
    // An empty list means "nothing matched" *or* "still looking". Treating those the
    // same closed the sheet on every keystroke, which is what flickered.
    expect(shouldShowSheet(0, true)).toBe(true);
    expect(shouldShowSheet(4, false)).toBe(true);
    expect(shouldShowSheet(0, false)).toBe(false);
  });
});
