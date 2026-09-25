import { webCryptoProvider } from "../../../src/crypto/webcrypto.mjs";
import { registerDevice } from "./api";

export interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface StoredDevice {
  deviceId: string;
  identity: KeyPair;
  encryption: KeyPair;
  fingerprint?: string;
  /** Account this controller key was enrolled for; the key is per-origin, not per-account. */
  accountId?: string;
}

const DB_NAME = "pinet";
const STORE = "device";
const KEY = "self";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
    });
  } finally {
    db.close();
  }
}

export async function loadDevice(): Promise<StoredDevice | null> {
  try {
    const value = await withStore<StoredDevice | undefined>("readonly", (store) => store.get(KEY));
    return value ?? null;
  } catch {
    return null;
  }
}

export async function saveDevice(device: StoredDevice): Promise<void> {
  await withStore("readwrite", (store) => store.put(device, KEY));
}

export async function clearDevice(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(KEY));
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/i.test(ua)) return "web (iOS)";
  if (/Android/i.test(ua)) return "web (Android)";
  if (/Macintosh/i.test(ua)) return "web (macOS)";
  if (/Windows/i.test(ua)) return "web (Windows)";
  if (/Linux/i.test(ua)) return "web (Linux)";
  return "web";
}

/**
 * Load this browser's controller identity, registering one on first use.
 *
 * The key is stored per-origin (IndexedDB has no notion of the signed-in
 * account), so when `accountId` is known and does not match the stored device,
 * the stale key is discarded and a fresh device is enrolled. Otherwise a browser
 * signed in to account B would keep talking to the coordinator as account A's
 * device and show the wrong account's hosts and sessions.
 */
export async function ensureDevice(accountId?: string): Promise<StoredDevice> {
  const existing = await loadDevice();
  if (existing && (!accountId || existing.accountId === accountId)) return existing;
  if (existing) await clearDevice();

  const identity = await webCryptoProvider.generateIdentityKeypair();
  const encryption = await webCryptoProvider.generateEncryptionKeypair();
  const identityPub = await webCryptoProvider.exportPublicKey(identity.publicKey);
  const encPub = await webCryptoProvider.exportPublicKey(encryption.publicKey);
  const { deviceId, fingerprint } = await registerDevice({ kind: "controller", name: deviceName(), identityPub, encPub });

  const device: StoredDevice = { deviceId, identity, encryption, fingerprint, accountId };
  await saveDevice(device);
  return device;
}
