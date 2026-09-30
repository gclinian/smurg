// A minimal key-value view of IndexedDB, so the device-key and pin logic can be unit-tested in Node against an
// in-memory store with the same structured-clone semantics. Values go through the browser's structured clone:
// what comes back must be re-validated by the caller (WebKit returns null for X25519 CryptoKeys).

export const DEVICE_KEY_STORE = 'device-keys';
export const DAEMON_PIN_STORE = 'daemon-pins';
export const SMURG_KEYS_DB_NAME = 'smurg-keys';
const SMURG_KEYS_DB_VERSION = 1;

export type KeyStoreName = typeof DEVICE_KEY_STORE | typeof DAEMON_PIN_STORE;

export interface KeyValueStore {
  get(store: KeyStoreName, key: string): Promise<unknown>;
  put(store: KeyStoreName, key: string, value: unknown): Promise<void>;
  /** Stores only if the key is absent; false when it already exists (atomic in IndexedDB: `add`). */
  add(store: KeyStoreName, key: string, value: unknown): Promise<boolean>;
  delete(store: KeyStoreName, key: string): Promise<void>;
}

export interface IndexedDbKeyValueStore extends KeyValueStore {
  close(): void;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Opens (and on first use creates) the `smurg-keys` database. Works in windows and Web Workers (the transfer
 * Worker opens its own connection and loads the device key itself: WebKit cannot post X25519 keys to a Worker).
 */
export async function openIndexedDbKeyValueStore(
  options: { factory?: IDBFactory; name?: string } = {},
): Promise<IndexedDbKeyValueStore> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available');
  const request = factory.open(options.name ?? SMURG_KEYS_DB_NAME, SMURG_KEYS_DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const store of [DEVICE_KEY_STORE, DAEMON_PIN_STORE]) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
  };
  const db = await requestResult(request);
  // Another tab upgrading the schema must not be blocked by us.
  db.onversionchange = () => db.close();

  const run = async <T>(store: KeyStoreName, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const tx = db.transaction(store, mode);
    // Both promises are observed, so a failed request does not leave the transaction's rejection unhandled.
    const [result] = await Promise.all([requestResult(op(tx.objectStore(store))), transactionDone(tx)]);
    return result;
  };

  return {
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    put: async (store, key, value) => {
      await run(store, 'readwrite', (s) => s.put(value, key));
    },
    add: async (store, key, value) => {
      try {
        await run(store, 'readwrite', (s) => s.add(value, key));
        return true;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'ConstraintError') return false;
        throw err;
      }
    },
    delete: async (store, key) => {
      await run(store, 'readwrite', (s) => s.delete(key));
    },
    close: () => db.close(),
  };
}

/**
 * In-memory KeyValueStore with IndexedDB's copy semantics (every put and get goes through structuredClone). For
 * tests, and as a non-persistent fallback where IndexedDB is unavailable (e.g. some private modes).
 */
export function createMemoryKeyValueStore(): KeyValueStore & { readonly size: number } {
  const data = new Map<string, unknown>();
  const id = (store: KeyStoreName, key: string) => `${store}\u0000${key}`;
  return {
    get size() {
      return data.size;
    },
    get: async (store, key) => {
      const k = id(store, key);
      return data.has(k) ? structuredClone(data.get(k)) : undefined;
    },
    put: async (store, key, value) => {
      data.set(id(store, key), structuredClone(value));
    },
    add: async (store, key, value) => {
      const k = id(store, key);
      if (data.has(k)) return false;
      data.set(k, structuredClone(value));
      return true;
    },
    delete: async (store, key) => {
      data.delete(id(store, key));
    },
  };
}
