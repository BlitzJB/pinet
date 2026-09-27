import { describe, expect, it } from "vitest";
import { levelSlots } from "../../web/src/lib/waveform.ts";

describe("waveform geometry", () => {
  it("puts the newest sample at the right edge", () => {
    const { half } = levelSlots([0.1, 0.9], { width: 4, height: 10, pitch: 2 });
    expect(half).toHaveLength(2);
    expect(half[1]).toBeGreaterThan(half[0]);
  });

  it("shifts what was captured leftwards as new samples arrive", () => {
    // The point of the component: a new sample must move the existing waveform
    // left, so the right edge is the live one and the rest is history.
    const before = levelSlots([0.2, 1, 0.6], { width: 4, height: 10, pitch: 2 });
    const after = levelSlots([0.2, 1, 0.6, 0.4], { width: 4, height: 10, pitch: 2 });
    expect(after.half[0]).toBe(before.half[1]); // the previous right edge moved left
    expect(after.half[1]).toBeGreaterThan(0); // and the new sample took the right edge
    expect(after.half[1]).toBeLessThan(after.half[0]);
  });

  it("right-aligns a short history instead of stretching it", () => {
    const { half } = levelSlots([0.5], { width: 8, height: 10, pitch: 2 });
    expect(half).toHaveLength(4);
    expect(half.slice(0, 3).every((value) => value === 1)).toBe(true);
    expect(half[3]).toBeGreaterThan(1);
  });

  it("draws a floor rather than collapsing when silent", () => {
    const { half } = levelSlots([0, 0, 0, 0], { width: 8, height: 10, pitch: 2 });
    expect(half.every((value) => value === 1)).toBe(true);
  });

  it("clamps out-of-range levels", () => {
    const { half } = levelSlots([5, -2], { width: 4, height: 10, pitch: 2 });
    expect(half[0]).toBe(4); // reach = height/2 - minHalf
    expect(half[1]).toBe(1);
  });
});
