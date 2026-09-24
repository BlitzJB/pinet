import { describe, expect, it } from "vitest";
import { Emitter } from "../../src/common/emitter.mjs";
import { createPortal, describeEntry } from "../../src/controller/portal.mjs";

const userEntry = (id, text) => ({ type: "message", id, parentId: null, message: { role: "user", content: text } });
const assistantEntry = (id, text) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "assistant", content: [{ type: "text", text }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] },
});
const toolEntry = (id) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "output" }], isError: false },
});

describe("describeEntry", () => {
  it("maps user, assistant (with tool call), tool result and system entries", () => {
    expect(describeEntry(userEntry("1", "hi"))).toMatchObject({ kind: "user", title: "you", body: "hi" });
    const assistant = describeEntry(assistantEntry("2", "hello"));
    expect(assistant.kind).toBe("assistant");
    expect(assistant.body).toContain("hello");
    expect(assistant.body).toContain("bash");
    expect(describeEntry(toolEntry("3"))).toMatchObject({ kind: "tool", title: "bash", body: "output" });
    expect(describeEntry({ type: "model_change", id: "4", provider: "x", modelId: "y" })).toMatchObject({ kind: "system", title: "model", body: "x/y" });
  });

  it("ignores empty assistant messages and unknown entry types", () => {
    expect(describeEntry({ type: "message", id: "5", message: { role: "assistant", content: [] } })).toBeNull();
    expect(describeEntry({ type: "label", id: "6" })).toBeNull();
    expect(describeEntry(null)).toBeNull();
  });
});

class FakeController extends Emitter {
  constructor() {
    super();
    this.commands = [];
  }
  async command(sessionId, op, args) {
    this.commands.push({ sessionId, op, args });
    return { accepted: true, mode: "steer" };
  }
}

describe("createPortal", () => {
  it("streams remote entries to the sink exactly once", () => {
    const controller = new FakeController();
    const appended = [];
    createPortal({ controller, sessionId: "s1", sink: { append: (record) => appended.push(record) } });

    controller.emit("snapshot", { sessionId: "s1", entries: [userEntry("1", "hi"), assistantEntry("2", "yo")] });
    controller.emit("entries", { sessionId: "s1", entries: [userEntry("1", "hi"), toolEntry("3")] });

    expect(appended.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("forwards prompts and control ops to the controller", async () => {
    const controller = new FakeController();
    const portal = createPortal({ controller, sessionId: "s1", sink: { append() {} } });
    await portal.sendPrompt("hello");
    await portal.abort();
    await portal.setModel("anthropic", "claude");
    expect(controller.commands).toEqual([
      { sessionId: "s1", op: "prompt", args: { text: "hello" } },
      { sessionId: "s1", op: "abort", args: {} },
      { sessionId: "s1", op: "set_model", args: { provider: "anthropic", modelId: "claude" } },
    ]);
  });

  it("exposes status and notify to the sink", () => {
    const controller = new FakeController();
    const statuses = [];
    const notices = [];
    createPortal({ controller, sessionId: "s1", sink: { append() {}, status: (s) => statuses.push(s), notify: (m, t) => notices.push({ m, t }) } });
    controller.emit("status", { sessionId: "s1", status: { phase: "running", model: { provider: "p", id: "m" } } });
    controller.emit("decrypt_error", { error: "boom" });
    expect(statuses[0]).toMatchObject({ phase: "running" });
    expect(notices[0]).toMatchObject({ t: "error" });
  });
});
