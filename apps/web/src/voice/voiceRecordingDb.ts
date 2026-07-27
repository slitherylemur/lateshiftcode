import type { PersistedRecordingMeta, RecordingPersistence } from "./voiceRecordingTypes";

// A dedicated IndexedDB database keeps voice recordings isolated from the
// connection-runtime store, so schema changes here never collide with it.
const DATABASE_NAME = "t3code:voice-recordings";
const DATABASE_VERSION = 1;
const RECORDINGS_STORE = "recordings";
const CHUNKS_STORE = "chunks";
const CHUNKS_BY_RECORDING_INDEX = "by_recording";

interface StoredChunk {
  readonly recordingId: string;
  readonly blob: Blob;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed")),
      { once: true },
    );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener(
      "upgradeneeded",
      () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RECORDINGS_STORE)) {
          database.createObjectStore(RECORDINGS_STORE, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
          const chunkStore = database.createObjectStore(CHUNKS_STORE, {
            keyPath: "seq",
            autoIncrement: true,
          });
          chunkStore.createIndex(CHUNKS_BY_RECORDING_INDEX, "recordingId", { unique: false });
        }
      },
      { once: true },
    );
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("Failed to open voice-recordings database")),
      { once: true },
    );
  });
}

/**
 * IndexedDB-backed recording persistence. Chunks are written as they arrive and
 * survive reloads/crashes; a recording is only removed once it is transcribed
 * or explicitly discarded. Falls back to an unavailable stub when IndexedDB is
 * missing (SSR / unsupported browsers), where the caller simply keeps the blob
 * in memory for the current session.
 */
export function createIndexedDbRecordingPersistence(): RecordingPersistence {
  let databasePromise: Promise<IDBDatabase> | null = null;
  const withDatabase = (): Promise<IDBDatabase> => {
    databasePromise ??= openDatabase();
    return databasePromise;
  };

  return {
    async createRecording(meta: PersistedRecordingMeta): Promise<void> {
      const database = await withDatabase();
      const transaction = database.transaction(RECORDINGS_STORE, "readwrite");
      transaction.objectStore(RECORDINGS_STORE).put(meta);
      await promisifyTransaction(transaction);
    },

    async appendChunk(id: string, chunk: Blob): Promise<void> {
      const database = await withDatabase();
      const transaction = database.transaction([CHUNKS_STORE, RECORDINGS_STORE], "readwrite");
      const stored: StoredChunk = { recordingId: id, blob: chunk };
      transaction.objectStore(CHUNKS_STORE).add(stored);
      const recordingStore = transaction.objectStore(RECORDINGS_STORE);
      const existing = (await promisifyRequest(recordingStore.get(id))) as
        | PersistedRecordingMeta
        | undefined;
      if (existing) {
        recordingStore.put({ ...existing, sizeBytes: existing.sizeBytes + chunk.size });
      }
      await promisifyTransaction(transaction);
    },

    async updateRecording(
      id: string,
      patch: Partial<Omit<PersistedRecordingMeta, "id" | "createdAt" | "mimeType">>,
    ): Promise<void> {
      const database = await withDatabase();
      const transaction = database.transaction(RECORDINGS_STORE, "readwrite");
      const store = transaction.objectStore(RECORDINGS_STORE);
      const existing = (await promisifyRequest(store.get(id))) as
        | PersistedRecordingMeta
        | undefined;
      if (existing) {
        store.put({ ...existing, ...patch });
      }
      await promisifyTransaction(transaction);
    },

    async getRecording(id: string): Promise<PersistedRecordingMeta | null> {
      const database = await withDatabase();
      const transaction = database.transaction(RECORDINGS_STORE, "readonly");
      const result = (await promisifyRequest(transaction.objectStore(RECORDINGS_STORE).get(id))) as
        | PersistedRecordingMeta
        | undefined;
      return result ?? null;
    },

    async getPendingRecording(): Promise<PersistedRecordingMeta | null> {
      const database = await withDatabase();
      const transaction = database.transaction(RECORDINGS_STORE, "readonly");
      const all = (await promisifyRequest(
        transaction.objectStore(RECORDINGS_STORE).getAll(),
      )) as PersistedRecordingMeta[];
      if (all.length === 0) {
        return null;
      }
      // Only unfinished recordings are ever persisted; pick the most recent.
      return all.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    },

    async loadAudioBlob(id: string): Promise<Blob | null> {
      const database = await withDatabase();
      const transaction = database.transaction(CHUNKS_STORE, "readonly");
      const index = transaction.objectStore(CHUNKS_STORE).index(CHUNKS_BY_RECORDING_INDEX);
      const chunks = (await promisifyRequest(index.getAll(IDBKeyRange.only(id)))) as StoredChunk[];
      if (chunks.length === 0) {
        return null;
      }
      const meta = await this.getRecording(id);
      const blobs = chunks.map((entry) => entry.blob);
      return new Blob(blobs, meta?.mimeType ? { type: meta.mimeType } : undefined);
    },

    async deleteRecording(id: string): Promise<void> {
      const database = await withDatabase();
      const transaction = database.transaction([CHUNKS_STORE, RECORDINGS_STORE], "readwrite");
      transaction.objectStore(RECORDINGS_STORE).delete(id);
      const index = transaction.objectStore(CHUNKS_STORE).index(CHUNKS_BY_RECORDING_INDEX);
      const keys = (await promisifyRequest(
        index.getAllKeys(IDBKeyRange.only(id)),
      )) as IDBValidKey[];
      const chunkStore = transaction.objectStore(CHUNKS_STORE);
      for (const key of keys) {
        chunkStore.delete(key);
      }
      await promisifyTransaction(transaction);
    },
  };
}

function promisifyTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
      { once: true },
    );
  });
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}
