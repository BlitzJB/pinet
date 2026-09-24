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

/** Load this browser's controller identity, registering one on first use. */
export async function ensureDevice(): Promise<StoredDevice> {
  const existing = await loadDevice();
  if (existing) return existing;

  const identity = await webCryptoProvider.generateIdentityKeypair();
  const encryption = await webCryptoProvider.generateEncryptionKeypair();
  const identityPub = await webCryptoProvider.exportPublicKey(identity.publicKey);
  const encPub = await webCryptoProvider.exportPublicKey(encryption.publicKey);
  const { deviceId, fingerprint } = await registerDevice({ kind: "controller", name: deviceName(), identityPub, encPub });

  const device: StoredDevice = { deviceId, identity, encryption, fingerprint };
  await saveDevice(device);
  return device;
}
