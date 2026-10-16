/**
 * The text you have typed but not sent, per session.
 *
 * IndexedDB rather than localStorage. Drafts are small, but localStorage is a shared
 * ~5MB budget the browser is free to evict — and evicting someone's half-written message
 * is a worse failure than the few milliseconds an async write costs. Old drafts are
 * dropped after a fortnight, on the same lazy-expiry scheme as attachments.
 */
import { STORE_DRAFTS, pruneByExpiry, run } from "./idb";

const MAX_CHARS = 64 * 1024;
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface Draft {
  sessionId: string;
  text: string;
  expiresAt: number;
}

export async function loadDraft(sessionId: string): Promise<string> {
  try {
    const record = await run<Draft | undefined>(STORE_DRAFTS, "readonly", (store) => store.get(sessionId));
    if (!record) return "";
    if (record.expiresAt <= Date.now()) {
      await clearDraft(sessionId);
      return "";
    }
    return record.text;
  } catch {
    return "";
  }
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
  try {
    if (text.length === 0) {
      await clearDraft(sessionId);
      return;
    }
    // A pasted novel is not worth a quota problem; keep the first chunk rather than fail.
    const record: Draft = { sessionId, text: text.slice(0, MAX_CHARS), expiresAt: Date.now() + TTL_MS };
    await run(STORE_DRAFTS, "readwrite", (store) => store.put(record));
  } catch {
    /* private mode, or a locked profile: the draft simply does not survive the tab */
  }
}

export async function clearDraft(sessionId: string): Promise<void> {
  try {
    await run(STORE_DRAFTS, "readwrite", (store) => store.delete(sessionId));
  } catch {
    /* nothing to do */
  }
}

/** Drop drafts nobody has touched in a fortnight. */
export async function pruneDrafts(): Promise<void> {
  try {
    await pruneByExpiry<Draft>(STORE_DRAFTS, () =>
      run<Draft[]>(STORE_DRAFTS, "readonly", (store) => store.getAll()),
    );
  } catch {
    /* best effort */
  }
}
