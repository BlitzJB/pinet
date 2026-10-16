/**
 * Attachments kept locally, so a pending upload survives a reload.
 *
 * IndexedDB, not localStorage: a screenshot is a Blob, localStorage is string-only and
 * synchronous, and its ~5MB budget is shared with everything else. IndexedDB
 * structured-clones Blobs directly, is asynchronous, and has a quota measured in
 * hundreds of megabytes.
 *
 * There is no TTL in IndexedDB, so expiry is lazy: every record carries `expiresAt`, and
 * anything past it is dropped the next time the store is opened. Object URLs are revoked
 * as records are dropped — they pin the blob in memory until they are, which is the
 * usual way this kind of cache leaks.
 */
const DB_NAME = "pinet";
const STORE = "attachments";
const VERSION = 1;
/** Long enough to survive a lunch break, short enough that a screenshot is not kept for weeks. */
export const ATTACHMENT_TTL_MS = 12 * 60 * 60 * 1000;

export interface StoredAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "text";
  /** Present for images, so the chip can show a thumbnail without a round trip. */
  blob?: Blob;
  /** Object URL derived from the blob, remembered so it can be revoked. */
  preview?: string;
  expiresAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = work(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      }),
  );
}

/** Drop anything past its expiry, revoking previews as it goes. */
export async function pruneAttachments(now = Date.now()): Promise<void> {
  try {
    const all = await run<StoredAttachment[]>("readonly", (store) => store.getAll() as IDBRequest<StoredAttachment[]>);
    for (const record of all) {
      if (record.expiresAt <= now) {
        if (record.preview) URL.revokeObjectURL(record.preview);
        await run("readwrite", (store) => store.delete(record.id) as unknown as IDBRequest<IDBValidKey>);
      }
    }
  } catch {
    /* no IndexedDB (private mode, or a locked profile): persistence is best effort */
  }
}

export async function putAttachment(record: Omit<StoredAttachment, "expiresAt">): Promise<void> {
  try {
    await run("readwrite", (store) =>
      store.put({ ...record, expiresAt: Date.now() + ATTACHMENT_TTL_MS }) as unknown as IDBRequest<IDBValidKey>,
    );
  } catch {
    /* best effort */
  }
}

/** Everything still within its TTL, newest first, pruning as it reads. */
export async function listAttachments(): Promise<StoredAttachment[]> {
  try {
    await pruneAttachments();
    const all = await run<StoredAttachment[]>("readonly", (store) => store.getAll() as IDBRequest<StoredAttachment[]>);
    return all.sort((a, b) => b.expiresAt - a.expiresAt);
  } catch {
    return [];
  }
}

export async function deleteAttachment(id: string): Promise<void> {
  try {
    const record = await run<StoredAttachment | undefined>("readonly", (store) => store.get(id) as IDBRequest<StoredAttachment | undefined>);
    if (record?.preview) URL.revokeObjectURL(record.preview);
    await run("readwrite", (store) => store.delete(id) as unknown as IDBRequest<IDBValidKey>);
  } catch {
    /* best effort */
  }
}
