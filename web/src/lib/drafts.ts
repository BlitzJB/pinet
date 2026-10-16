/**
 * The text you have typed but not sent, per session.
 *
 * localStorage is the right store for this and IndexedDB is not: drafts are small
 * strings, they are written on every keystroke, and a synchronous write of a few
 * hundred bytes is cheaper than the transaction an IndexedDB put would cost. The cap
 * matters because localStorage is a shared ~5MB budget — a huge paste should not be
 * able to evict everything else, so an oversized draft is simply not kept.
 */
const PREFIX = "pinet.draft.";
const MAX_BYTES = 32 * 1024;

const key = (sessionId: string) => `${PREFIX}${sessionId}`;

export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(key(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(sessionId: string, text: string): void {
  try {
    if (text.length === 0) {
      localStorage.removeItem(key(sessionId));
      return;
    }
    if (text.length > MAX_BYTES) return;
    localStorage.setItem(key(sessionId), text);
  } catch {
    /* private mode, or full: the draft simply does not survive the tab */
  }
}

export function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(key(sessionId));
  } catch {
    /* nothing to do */
  }
}
