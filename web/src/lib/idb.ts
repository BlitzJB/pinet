/**
 * One IndexedDB, two stores.
 *
 * Everything the browser keeps for us lives here: unsent text and attachments. Both are
 * the kind of thing a person would notice losing, and localStorage is the wrong home for
 * either — it is a shared ~5MB budget that the browser may evict, and it is synchronous.
 */
export const DB_NAME = "pinet";
export const DB_VERSION = 2;
export const STORE_ATTACHMENTS = "attachments";
export const STORE_DRAFTS = "drafts";

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) db.createObjectStore(STORE_ATTACHMENTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) db.createObjectStore(STORE_DRAFTS, { keyPath: "sessionId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function run<T>(store: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = work(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      }),
  );
}

/** Anything past its expiry is dropped; IndexedDB has no TTL of its own. */
export async function pruneByExpiry<T extends { id?: string; sessionId?: string; expiresAt: number }>(
  store: string,
  all: () => Promise<T[]>,
  onDrop?: (record: T) => void,
): Promise<T[]> {
  const records = await all();
  const live: T[] = [];
  for (const record of records) {
    if (record.expiresAt > Date.now()) {
      live.push(record);
      continue;
    }
    onDrop?.(record);
    const key = record.id ?? record.sessionId;
    if (key !== undefined) await run(store, "readwrite", (objectStore) => objectStore.delete(key));
  }
  return live;
}
