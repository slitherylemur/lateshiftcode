import type {
  PersistedRecordingMeta,
  RecordingPersistence,
  RetryScheduler,
  TranscribeFn,
  VoiceRecordingSnapshot,
} from "./voiceRecordingTypes";

export interface VoiceRecordingControllerDeps {
  readonly persistence: RecordingPersistence;
  readonly transcribe: TranscribeFn;
  /** Insert a successful transcript into the composer. */
  readonly onTranscript: (text: string) => void;
  /** Surface a user-facing error (e.g. a toast). */
  readonly onError: (message: string) => void;
  readonly now?: () => number;
  readonly schedule?: RetryScheduler;
  readonly generateId?: () => string;
  readonly maxAutoRetries?: number;
  readonly backoffBaseMs?: number;
}

const DEFAULT_MAX_AUTO_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 2000;

function defaultId(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const defaultScheduler: RetryScheduler = {
  schedule(delayMs, run) {
    const handle = setTimeout(run, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

const IDLE_SNAPSHOT: VoiceRecordingSnapshot = {
  phase: "idle",
  recordingId: null,
  errorMessage: null,
  autoRetryScheduled: false,
};

/**
 * Owns the durable lifecycle of a single voice recording: chunk persistence,
 * transcription, and the retry/backoff state machine. Capture (MediaRecorder,
 * permissions, elapsed timer) lives in the hook, which drives this controller.
 *
 * Robustness guarantees:
 * - Every chunk is written to persistence as it arrives, so a crash/reload
 *   never loses audio.
 * - A failed transcription is auto-retried with exponential backoff up to
 *   `maxAutoRetries`, then held in `failed` for a one-click manual retry.
 * - The recording stays in persistence until it is transcribed or discarded,
 *   and is recovered on the next launch via `hydrate()`.
 */
export class VoiceRecordingController {
  private readonly persistence: RecordingPersistence;
  private readonly transcribe: TranscribeFn;
  private readonly onTranscript: (text: string) => void;
  private readonly onError: (message: string) => void;
  private readonly now: () => number;
  private readonly scheduler: RetryScheduler;
  private readonly generateId: () => string;
  private readonly maxAutoRetries: number;
  private readonly backoffBaseMs: number;

  private snapshot: VoiceRecordingSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private cancelScheduledRetry: (() => void) | null = null;
  private activeId: string | null = null;

  constructor(deps: VoiceRecordingControllerDeps) {
    this.persistence = deps.persistence;
    this.transcribe = deps.transcribe;
    this.onTranscript = deps.onTranscript;
    this.onError = deps.onError;
    this.now = deps.now ?? (() => Date.now());
    this.scheduler = deps.schedule ?? defaultScheduler;
    this.generateId = deps.generateId ?? defaultId;
    this.maxAutoRetries = deps.maxAutoRetries ?? DEFAULT_MAX_AUTO_RETRIES;
    this.backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): VoiceRecordingSnapshot => this.snapshot;

  private setSnapshot(next: Partial<VoiceRecordingSnapshot>): void {
    const merged: VoiceRecordingSnapshot = { ...this.snapshot, ...next };
    if (
      merged.phase === this.snapshot.phase &&
      merged.recordingId === this.snapshot.recordingId &&
      merged.errorMessage === this.snapshot.errorMessage &&
      merged.autoRetryScheduled === this.snapshot.autoRetryScheduled
    ) {
      return;
    }
    this.snapshot = merged;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Recover a recording persisted by a previous session, if any. */
  async hydrate(): Promise<void> {
    if (this.activeId !== null) {
      return;
    }
    const pending = await this.persistence.getPendingRecording().catch(() => null);
    if (!pending) {
      return;
    }
    // Any non-completed status means the previous attempt was interrupted; hold
    // it as failed so the user can retry transcription or discard it.
    this.activeId = pending.id;
    if (pending.status !== "failed") {
      await this.persistence
        .updateRecording(pending.id, { status: "failed" })
        .catch(() => undefined);
    }
    this.setSnapshot({
      phase: "failed",
      recordingId: pending.id,
      errorMessage:
        pending.lastError ??
        "A previous recording was interrupted. Retry transcription or discard.",
      autoRetryScheduled: false,
    });
  }

  /** Begin a new capture. Returns the new recording id. */
  async beginCapture(mimeType: string): Promise<string> {
    this.clearScheduledRetry();
    // Only one pending recording at a time: discard any previous one.
    if (this.activeId !== null) {
      await this.discardInternal(this.activeId);
    }
    const id = this.generateId();
    const meta: PersistedRecordingMeta = {
      id,
      mimeType,
      createdAt: this.now(),
      status: "recording",
      durationMs: 0,
      sizeBytes: 0,
      autoRetriesUsed: 0,
      lastError: null,
    };
    await this.persistence.createRecording(meta);
    this.activeId = id;
    this.setSnapshot({
      phase: "recording",
      recordingId: id,
      errorMessage: null,
      autoRetryScheduled: false,
    });
    return id;
  }

  /** Persist a chunk as it arrives. Never throws. */
  async pushChunk(chunk: Blob): Promise<void> {
    const id = this.activeId;
    if (id === null || chunk.size === 0) {
      return;
    }
    try {
      await this.persistence.appendChunk(id, chunk);
    } catch {
      // A dropped chunk write must not crash capture; the recording keeps going
      // and remaining chunks still persist.
    }
  }

  /** Finish capture and begin transcription. */
  async finishCapture(durationMs: number): Promise<void> {
    const id = this.activeId;
    if (id === null) {
      return;
    }
    await this.persistence
      .updateRecording(id, { status: "captured", durationMs })
      .catch(() => undefined);
    await this.runTranscription(id, { manual: false });
  }

  /** Manual retry of the currently failed recording. */
  async retry(): Promise<void> {
    const id = this.activeId;
    if (id === null || this.snapshot.phase !== "failed") {
      return;
    }
    this.clearScheduledRetry();
    // A manual retry resets the automatic-retry budget.
    await this.persistence
      .updateRecording(id, { status: "captured", autoRetriesUsed: 0 })
      .catch(() => undefined);
    await this.runTranscription(id, { manual: true });
  }

  /** Discard the current recording and return to idle. */
  async discard(): Promise<void> {
    const id = this.activeId;
    this.clearScheduledRetry();
    if (id !== null) {
      await this.discardInternal(id);
    }
    this.activeId = null;
    this.setSnapshot(IDLE_SNAPSHOT);
  }

  private async discardInternal(id: string): Promise<void> {
    await this.persistence.deleteRecording(id).catch(() => undefined);
  }

  private clearScheduledRetry(): void {
    if (this.cancelScheduledRetry !== null) {
      this.cancelScheduledRetry();
      this.cancelScheduledRetry = null;
    }
  }

  private async runTranscription(id: string, options: { manual: boolean }): Promise<void> {
    this.clearScheduledRetry();
    const meta = await this.persistence.getRecording(id).catch(() => null);
    if (!meta) {
      // Recording vanished (discarded elsewhere); nothing to do.
      if (this.activeId === id) {
        this.activeId = null;
        this.setSnapshot(IDLE_SNAPSHOT);
      }
      return;
    }
    const blob = await this.persistence.loadAudioBlob(id).catch(() => null);
    if (!blob || blob.size === 0) {
      await this.persistence
        .updateRecording(id, { status: "failed", lastError: "The recording was empty." })
        .catch(() => undefined);
      this.setSnapshot({
        phase: "failed",
        recordingId: id,
        errorMessage: "The recording was empty.",
        autoRetryScheduled: false,
      });
      return;
    }

    await this.persistence.updateRecording(id, { status: "transcribing" }).catch(() => undefined);
    this.setSnapshot({
      phase: "transcribing",
      recordingId: id,
      errorMessage: null,
      autoRetryScheduled: false,
    });

    let result: Awaited<ReturnType<TranscribeFn>>;
    try {
      result = await this.transcribe(blob, meta.mimeType);
    } catch (error) {
      result = {
        ok: false,
        retryable: true,
        message: error instanceof Error ? error.message : "Transcription failed.",
      };
    }

    if (this.activeId !== id) {
      // The recording was discarded/replaced while the request was in flight.
      return;
    }

    if (result.ok) {
      this.onTranscript(result.text);
      await this.discardInternal(id);
      this.activeId = null;
      this.setSnapshot(IDLE_SNAPSHOT);
      return;
    }

    const retriesUsed = meta.autoRetriesUsed;
    const canAutoRetry = result.retryable && !options.manual && retriesUsed < this.maxAutoRetries;
    await this.persistence
      .updateRecording(id, {
        status: "failed",
        lastError: result.message,
        autoRetriesUsed: canAutoRetry ? retriesUsed + 1 : retriesUsed,
      })
      .catch(() => undefined);

    if (canAutoRetry) {
      const delay = this.backoffBaseMs * Math.pow(2, retriesUsed);
      this.setSnapshot({
        phase: "failed",
        recordingId: id,
        errorMessage: result.message,
        autoRetryScheduled: true,
      });
      this.cancelScheduledRetry = this.scheduler.schedule(delay, () => {
        this.cancelScheduledRetry = null;
        void this.runTranscription(id, { manual: false });
      });
      return;
    }

    // Out of automatic retries (or a non-retryable error): hold for manual retry.
    this.onError(result.message);
    this.setSnapshot({
      phase: "failed",
      recordingId: id,
      errorMessage: result.message,
      autoRetryScheduled: false,
    });
  }
}
