/**
 * Document storage for the on-device build.
 *
 * Documents are kept in IndexedDB rather than localStorage: a repository is
 * easily a few megabytes, and localStorage caps out around five and throws. When
 * IndexedDB is unavailable (private windows, ancient WebViews) this falls back to
 * localStorage and then to memory, so the app still works for the session rather
 * than refusing to start.
 *
 * Nothing here talks to a network. That is the point of the Android build.
 */
import type { LocalDoc, LocalSource } from './local-brain.js';

const DB_NAME = 'idol-ai';
const DB_VERSION = 1;
const STORE = 'sources';
const FALLBACK_KEY = 'idol.documents.v1';

export interface StoredSource {
  id: string;
  name: string;
  addedAt: string;
  docs: LocalDoc[];
}

interface Store {
  list(): Promise<StoredSource[]>;
  put(source: StoredSource): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                          */
/* ------------------------------------------------------------------ */

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open'));
  });
}

function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

const indexedDbStore: Store = {
  async list() {
    const db = await openDatabase();
    try {
      return (await transaction<StoredSource[]>(db, 'readonly', (store) => store.getAll() as IDBRequest<StoredSource[]>)) ?? [];
    } finally {
      db.close();
    }
  },
  async put(source) {
    const db = await openDatabase();
    try {
      await transaction(db, 'readwrite', (store) => store.put(source) as IDBRequest<IDBValidKey>);
    } finally {
      db.close();
    }
  },
  async delete(id) {
    const db = await openDatabase();
    try {
      await transaction(db, 'readwrite', (store) => store.delete(id) as IDBRequest<undefined>);
    } finally {
      db.close();
    }
  },
  async clear() {
    const db = await openDatabase();
    try {
      await transaction(db, 'readwrite', (store) => store.clear() as IDBRequest<undefined>);
    } finally {
      db.close();
    }
  },
};

/* ------------------------------------------------------------------ */
/* Fallbacks                                                          */
/* ------------------------------------------------------------------ */

const memoryStore: Store = (() => {
  const map = new Map<string, StoredSource>();
  return {
    async list() {
      return [...map.values()];
    },
    async put(source) {
      map.set(source.id, source);
    },
    async delete(id) {
      map.delete(id);
    },
    async clear() {
      map.clear();
    },
  };
})();

const localStorageStore: Store = {
  async list() {
    try {
      const raw = window.localStorage.getItem(FALLBACK_KEY);
      return raw ? (JSON.parse(raw) as StoredSource[]) : [];
    } catch {
      return [];
    }
  },
  async put(source) {
    const all = await localStorageStore.list();
    const next = all.filter((item) => item.id !== source.id).concat(source);
    window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(next));
  },
  async delete(id) {
    const all = await localStorageStore.list();
    window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(all.filter((item) => item.id !== id)));
  },
  async clear() {
    window.localStorage.removeItem(FALLBACK_KEY);
  },
};

/** Picks the best storage this browser allows, once. */
function pickStore(): Store {
  if (typeof indexedDB === 'undefined') {
    return typeof window !== 'undefined' && window.localStorage ? localStorageStore : memoryStore;
  }
  return indexedDbStore;
}

let resolved: Store | null = null;

export function documentStore(): Store {
  resolved ??= pickStore();
  return resolved;
}

/**
 * Reads stored sources and hands them to the brain. Storage failures are not fatal:
 * a corpus that cannot be replayed still lets the app answer for this session.
 */
export async function restoreInto(brain: { load: (source: LocalSource) => unknown }): Promise<StoredSource[]> {
  try {
    const sources = await documentStore().list();
    for (const source of sources) {
      brain.load({ id: source.id, name: source.name, docs: source.docs });
    }
    return sources;
  } catch {
    return [];
  }
}
