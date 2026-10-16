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
  const request = (version?: number) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const open = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) db.createObjectStore(STORE_ATTACHMENTS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) db.createObjectStore(STORE_DRAFTS, { keyPath: "sessionId" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });

  return request(DB_VERSION).catch((error: unknown) => {
    // A tab still running an older bundle can hold this database at a higher version than
    // the one we ask for, and the open fails outright. That is not a reason to break: open
    // whatever version exists and use the stores that are actually there. Each caller
    // already treats a missing store as "nothing stored", so the feature degrades quietly
    // instead of taking the app down.
    if ((error as { name?: string })?.name === "VersionError") return request();
    throw error;
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
