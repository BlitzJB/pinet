/**
 * Transcript paging arithmetic, kept pure so it can be unit tested.
 *
 * A snapshot ships only a recent tail of a long session; older blocks are pulled
 * in on demand. The cursor is the host's index of the oldest entry the controller
 * currently holds, so `history` with `{ before: cursor }` walks backwards.
 */

export const HISTORY_PAGE_SIZE = 150;
export const INITIAL_ENTRY_LIMIT = 200;

/** Half-open `[start, end)` window of entries ending at `before` (defaults to the newest). */
export function historyWindow(total, before, limit = HISTORY_PAGE_SIZE) {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : HISTORY_PAGE_SIZE;
  const end =
    typeof before === "number" && Number.isFinite(before)
      ? Math.min(Math.max(0, Math.floor(before)), safeTotal)
      : safeTotal;
  const start = Math.max(0, end - safeLimit);
  return { start, end, cursor: start, hasMore: start > 0, total: safeTotal };
}
