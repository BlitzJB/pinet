import { describe, expect, it } from "vitest";
import { HISTORY_PAGE_SIZE, INITIAL_ENTRY_LIMIT, historyWindow } from "../../src/host/history.mjs";

describe("historyWindow", () => {
  it("takes the tail by default and reports the cursor as the start index", () => {
    expect(historyWindow(1000, undefined, 200)).toEqual({ start: 800, end: 1000, cursor: 800, hasMore: true, total: 1000 });
  });

  it("walks backwards page by page until the beginning", () => {
    const first = historyWindow(1000, 800);
    expect(first).toMatchObject({ start: 650, end: 800, cursor: 650, hasMore: true });

    const second = historyWindow(1000, 650);
    expect(second).toMatchObject({ start: 500, end: 650, hasMore: true });

    const third = historyWindow(1000, 500);
    expect(third).toMatchObject({ start: 350, end: 500, hasMore: true });

    // ...down to the start
    const last = historyWindow(1000, HISTORY_PAGE_SIZE);
    expect(last).toMatchObject({ start: 0, end: 150, cursor: 0, hasMore: false });
  });

  it("has nothing more when the whole transcript already fits in a snapshot", () => {
    expect(historyWindow(120, undefined, INITIAL_ENTRY_LIMIT)).toEqual({
      start: 0,
      end: 120,
      cursor: 0,
      hasMore: false,
      total: 120,
    });
  });

  it("clamps a cursor that exceeds the transcript (compaction shrank it)", () => {
    expect(historyWindow(50, 900)).toMatchObject({ start: 0, end: 50, cursor: 0, hasMore: false });
  });

  it("is defensive about junk input", () => {
    expect(historyWindow(0)).toMatchObject({ start: 0, end: 0, hasMore: false, total: 0 });
    expect(historyWindow(NaN)).toMatchObject({ start: 0, end: 0, total: 0 });
    expect(historyWindow(300, -5)).toMatchObject({ start: 0, end: 0, cursor: 0 });
    expect(historyWindow(300, undefined, 0)).toMatchObject({ end: 300, start: 150 });
  });
});
