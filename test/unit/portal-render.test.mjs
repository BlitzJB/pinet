import { describe, expect, it } from "vitest";
import { renderRemote } from "../../extension/portal.ts";

// Minimal Theme stand-in: identity colors so we can assert on plain content.
const theme = { fg: (_name, text) => text, bg: (_name, text) => text, bold: (text) => text };

describe("renderRemote", () => {
  it("renders assistant markdown and tool calls", () => {
    const component = renderRemote(
      { kind: "assistant", text: "# Title\n\nhello `code`", tools: [{ name: "bash", args: '{"command":"ls"}' }] },
      false,
      theme,
    );
    const out = component.render(80).join("\n");
    expect(out).toContain("Title");
    expect(out).toContain("hello");
    expect(out).toContain("code");
    expect(out).toContain("bash");
  });

  it("renders user and system records", () => {
    expect(renderRemote({ kind: "user", text: "hi there" }, false, theme).render(80).join("\n")).toContain("hi there");
    expect(renderRemote({ kind: "system", title: "model", body: "anthropic/claude" }, false, theme).render(80).join("\n")).toContain("anthropic/claude");
  });

  it("collapses long tool output and expands it on request", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const collapsed = renderRemote({ kind: "tool", title: "bash", text: long }, false, theme).render(120).join("\n");
    expect(collapsed).toContain("more lines");
    expect(collapsed).not.toContain("line 39");
    const expanded = renderRemote({ kind: "tool", title: "bash", text: long }, true, theme).render(120).join("\n");
    expect(expanded).toContain("line 39");
  });
});
