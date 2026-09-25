import { describe, expect, it } from "vitest";
import { deriveRunFeedback } from "../../web/src/lib/run-state.ts";

const base = { running: false, runningTools: 0, entryCount: 1 };

describe("deriveRunFeedback", () => {
  it("shows sending before the host ack", () => {
    expect(deriveRunFeedback({ ...base, outbox: { status: "sending", at: 0, entriesAt: 1 } })).toEqual({ label: "Sending…", active: false });
  });

  it("shows delivered after an immediate ack", () => {
    expect(deriveRunFeedback({ ...base, outbox: { status: "delivered", at: 0, entriesAt: 1 } })).toEqual({ label: "Delivered", active: false });
  });

  it("shows queued with the delivery mode", () => {
    const feedback = deriveRunFeedback({ ...base, outbox: { status: "queued", mode: "steer", at: 0, entriesAt: 1 } });
    expect(feedback?.label).toBe("Queued · steer");
    expect(feedback?.active).toBe(false);
  });

  it("shows working until the first block, then clears", () => {
    const outbox = { status: "working", at: 0, entriesAt: 1, sawRun: true };
    expect(deriveRunFeedback({ ...base, outbox, running: true })).toEqual({ label: "Working…", active: true });
    // first block arrived (entryCount grew past entriesAt)
    expect(deriveRunFeedback({ ...base, outbox, running: true, entryCount: 2 })).toBeNull();
  });

  it("stays quiet while a tool is visibly running", () => {
    const outbox = { status: "working", at: 0, entriesAt: 1, sawRun: true };
    expect(deriveRunFeedback({ ...base, outbox, running: true, runningTools: 1 })).toBeNull();
  });

  it("surfaces a delivery failure", () => {
    const feedback = deriveRunFeedback({ ...base, outbox: { status: "error", at: 0, error: "host_unavailable" } });
    expect(feedback).toMatchObject({ active: false, error: "host_unavailable" });
  });

  it("shows working for a run started by another controller", () => {
    expect(deriveRunFeedback({ ...base, outbox: null, running: true })).toEqual({ label: "Working…", active: true });
  });

  it("shows compaction while the context is being compacted", () => {
    expect(deriveRunFeedback({ ...base, outbox: null, running: true, compacting: true })).toEqual({
      label: "Compacting context…",
      active: true,
    });
    expect(deriveRunFeedback({ ...base, outbox: { status: "sending", at: 0, entriesAt: 1 }, compacting: true }).label).toBe(
      "Compacting context…",
    );
  });
});
