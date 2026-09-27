import { describe, expect, it } from "vitest";
import { levelColumns } from "../../web/src/lib/waveform.ts";

// slots = width/pitch = 4, so 4 columns of 4 samples = 16 samples on screen.
const opts = { width: 8, height: 21, pitch: 2, samplesPerColumn: 4 };
const reach = 21 / 2 - 1;

describe("waveform columns", () => {
  it("aggregates each column over its slice of time", () => {
    const columns = levelColumns([0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0, 1, 1, 1, 1], opts).columns;
    expect(columns.map((value) => +value.toFixed(3))).toEqual([0.25, 0.5, 0, 1]);
  });

  it("advances exactly one column per slice, so it scrolls slowly", () => {
    const base = Array.from({ length: 16 }, (_, i) => i / 16);
    const advanced = [...base.slice(4), 0.9, 0.9, 0.9, 0.9];
    expect(levelColumns(advanced, opts).columns[0]).toBeCloseTo(levelColumns(base, opts).columns[1], 6);
  });

  it("moves less than a full column for a single new sample", () => {
    const base = Array.from({ length: 16 }, (_, i) => i / 16);
    const nudged = [...base.slice(1), 0.9];
    const before = levelColumns(base, opts).columns;
    const after = levelColumns(nudged, opts).columns;
    expect(Math.abs(after[0] - before[0])).toBeLessThan(Math.abs(before[1] - before[0]));
  });

  it("scales to the recent average, so quiet speech still varies", () => {
    // Four quiet columns, each louder than the last: without an adaptive scale
    // these would all sit on the floor.
    const quiet = [0.03, 0.03, 0.03, 0.03, 0.05, 0.05, 0.05, 0.05, 0.07, 0.07, 0.07, 0.07, 0.04, 0.04, 0.04, 0.04];
    const { half, reference } = levelColumns(quiet, opts);
    expect(reference).toBeLessThan(0.2); // scaled to this signal, not to full scale
    expect(Math.max(...half)).toBeGreaterThan(reach * 0.6);
    expect(Math.max(...half) - Math.min(...half)).toBeGreaterThan(reach * 0.3);
  });

  it("draws a floor when silent and stays within reach when loud", () => {
    expect(levelColumns(new Array(16).fill(0), opts).half.every((value) => value === 1)).toBe(true);
    const loud = levelColumns(new Array(16).fill(1), opts).half;
    expect(loud.every((value) => value > 0 && value <= reach)).toBe(true);
  });

  it("right-aligns a short history instead of stretching it", () => {
    const { columns } = levelColumns([0.2, 0.2, 0.2, 0.2], opts);
    expect(columns.slice(0, 3)).toEqual([0, 0, 0]);
    expect(columns[3]).toBeCloseTo(0.2, 6);
  });
});
