// Lifecycle status persisted alongside a recording so an interrupted recording
// (tab crash, reload, failed transcription) can be recovered after restart.
export type PersistedRecordingStatus =
  | "recording" // capture in progress; chunks are still arriving
  | "captured" // capture finished; not yet transcribed
  | "transcribing" // a transcription request is in flight
  | "failed"; // transcription failed and is awaiting retry/discard

export interface PersistedRecordingMeta {
  readonly id: string;
  readonly mimeType: string;
  readonly createdAt: number;
  status: PersistedRecordingStatus;
  durationMs: number;
  sizeBytes: number;
  autoRetriesUsed: number;
  lastError: string | null;
}

/**
 * Storage abstraction for recordings and their audio chunks. The production
 * implementation is IndexedDB (survives reloads/crashes); tests inject an
 * in-memory implementation. Chunks are appended as they arrive so a recording
 * is never lost, even mid-capture.
 */
export interface RecordingPersistence {
  createRecording(meta: PersistedRecordingMeta): Promise<void>;
  appendChunk(id: string, chunk: Blob): Promise<void>;
  updateRecording(
    id: string,
    patch: Partial<Omit<PersistedRecordingMeta, "id" | "createdAt" | "mimeType">>,
  ): Promise<void>;
  getRecording(id: string): Promise<PersistedRecordingMeta | null>;
  /** The most recent recording that is not yet completed, if any. */
  getPendingRecording(): Promise<PersistedRecordingMeta | null>;
  /** Assemble the persisted chunks into a single blob, or null if none. */
  loadAudioBlob(id: string): Promise<Blob | null>;
  deleteRecording(id: string): Promise<void>;
}

export type TranscribeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly retryable: boolean; readonly message: string };

export type TranscribeFn = (blob: Blob, mimeType: string) => Promise<TranscribeResult>;

export interface RetryScheduler {
  /** Schedule `run` after `delayMs`; returns a cancel function. */
  schedule(delayMs: number, run: () => void): () => void;
}

// UI-facing phase. Capture concerns (permission, elapsed time) live in the hook.
export type VoicePhase = "idle" | "recording" | "transcribing" | "failed";

export interface VoiceRecordingSnapshot {
  readonly phase: VoicePhase;
  readonly recordingId: string | null;
  readonly errorMessage: string | null;
  /** True while an automatic retry is scheduled (before the manual fallback). */
  readonly autoRetryScheduled: boolean;
}
