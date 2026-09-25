import { describe, expect, it } from "vitest";
import { createSeqTracker } from "../../src/controller/seq-tracker.mjs";

describe("seq tracker", () => {
  it("treats the first frame as a baseline", () => {
    const tracker = createSeqTracker();
    expect(tracker.observe("s1", 1, 10)).toEqual({ gap: false, reset: true });
  });

  it("does not flag consecutive frames", () => {
    const tracker = createSeqTracker();
    tracker.observe("s1", 1, 10);
    expect(tracker.observe("s1", 1, 11).gap).toBe(false);
    expect(tracker.observe("s1", 1, 12).gap).toBe(false);
  });

  it("flags a gap and keeps tracking from the new seq", () => {
    const tracker = createSeqTracker();
    tracker.observe("s1", 1, 10);
    const result = tracker.observe("s1", 1, 14);
    expect(result.gap).toBe(true);
    expect(tracker.observe("s1", 1, 15).gap).toBe(false);
  });

  it("resets on epoch change", () => {
    const tracker = createSeqTracker();
    tracker.observe("s1", 1, 10);
    expect(tracker.observe("s1", 2, 1)).toEqual({ gap: false, reset: true });
  });

  it("resets on demand", () => {
    const tracker = createSeqTracker();
    tracker.observe("s1", 1, 10);
    tracker.reset("s1");
    expect(tracker.observe("s1", 1, 99).reset).toBe(true);
  });
});
