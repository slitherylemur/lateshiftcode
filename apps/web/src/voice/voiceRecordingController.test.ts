import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceRecordingController } from "./voiceRecordingController.ts";
import type {
  PersistedRecordingMeta,
  RecordingPersistence,
  RetryScheduler,
  TranscribeResult,
} from "./voiceRecordingTypes.ts";

class InMemoryPersistence implements RecordingPersistence {
  readonly metas = new Map<string, PersistedRecordingMeta>();
  readonly chunks = new Map<string, Blob[]>();

  async createRecording(meta: PersistedRecordingMeta): Promise<void> {
    this.metas.set(meta.id, { ...meta });
    this.chunks.set(meta.id, []);
  }
  async appendChunk(id: string, chunk: Blob): Promise<void> {
    const list = this.chunks.get(id) ?? [];
    list.push(chunk);
    this.chunks.set(id, list);
    const meta = this.metas.get(id);
    if (meta) {
      meta.sizeBytes += chunk.size;
    }
  }
  async updateRecording(
    id: string,
    patch: Partial<Omit<PersistedRecordingMeta, "id" | "createdAt" | "mimeType">>,
  ): Promise<void> {
    const meta = this.metas.get(id);
    if (meta) {
      Object.assign(meta, patch);
    }
  }
  async getRecording(id: string): Promise<PersistedRecordingMeta | null> {
    const meta = this.metas.get(id);
    return meta ? { ...meta } : null;
  }
  async getPendingRecording(): Promise<PersistedRecordingMeta | null> {
    const all = [...this.metas.values()].sort((a, b) => b.createdAt - a.createdAt);
    return all.length > 0 ? { ...all[0]! } : null;
  }
  async loadAudioBlob(id: string): Promise<Blob | null> {
    const list = this.chunks.get(id);
    if (!list || list.length === 0) {
      return null;
    }
    const mimeType = this.metas.get(id)?.mimeType;
    return new Blob(list, mimeType === undefined ? undefined : { type: mimeType });
  }
  async deleteRecording(id: string): Promise<void> {
    this.metas.delete(id);
    this.chunks.delete(id);
  }
}

class FakeScheduler implements RetryScheduler {
  pending: Array<{ delayMs: number; run: () => void }> = [];
  schedule(delayMs: number, run: () => void): () => void {
    const entry = { delayMs, run };
    this.pending.push(entry);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== entry);
    };
  }
  async runNext(): Promise<void> {
    const entry = this.pending.shift();
    if (entry) {
      entry.run();
    }
    await flushPromises();
  }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeController(options: {
  persistence?: InMemoryPersistence;
  scheduler?: FakeScheduler;
  outcomes: TranscribeResult[];
  onTranscript?: (text: string) => void;
  onError?: (message: string) => void;
}) {
  const persistence = options.persistence ?? new InMemoryPersistence();
  const scheduler = options.scheduler ?? new FakeScheduler();
  const outcomes = [...options.outcomes];
  const transcribe = vi.fn(async (): Promise<TranscribeResult> => {
    const next = outcomes.shift();
    if (!next) {
      throw new Error("no more outcomes");
    }
    return next;
  });
  let counter = 0;
  const controller = new VoiceRecordingController({
    persistence,
    transcribe,
    onTranscript: options.onTranscript ?? (() => {}),
    onError: options.onError ?? (() => {}),
    schedule: scheduler,
    now: () => 1000 + counter,
    generateId: () => `rec-${(counter += 1)}`,
    backoffBaseMs: 10,
  });
  return { controller, persistence, scheduler, transcribe };
}

async function captureAndFinish(controller: VoiceRecordingController): Promise<void> {
  await controller.beginCapture("audio/webm");
  await controller.pushChunk(new Blob(["chunk-a"]));
  await controller.pushChunk(new Blob(["chunk-b"]));
  await controller.finishCapture(4200);
}

describe("VoiceRecordingController", () => {
  it("persists chunks as they arrive during capture", async () => {
    const { controller, persistence } = makeController({ outcomes: [{ ok: true, text: "hi" }] });
    const id = await controller.beginCapture("audio/webm");
    await controller.pushChunk(new Blob(["a"]));
    await controller.pushChunk(new Blob(["bb"]));
    expect(persistence.chunks.get(id)).toHaveLength(2);
    expect(persistence.metas.get(id)?.sizeBytes).toBe(3);
    expect(controller.getSnapshot().phase).toBe("recording");
  });

  it("inserts the transcript and clears persistence on success", async () => {
    const onTranscript = vi.fn();
    const { controller, persistence } = makeController({
      outcomes: [{ ok: true, text: "hello world" }],
      onTranscript,
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(onTranscript).toHaveBeenCalledWith("hello world");
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(persistence.metas.size).toBe(0);
  });

  it("auto-retries a retryable failure with backoff, then succeeds", async () => {
    const onTranscript = vi.fn();
    const { controller, scheduler, transcribe } = makeController({
      outcomes: [
        { ok: false, retryable: true, message: "5xx" },
        { ok: false, retryable: true, message: "5xx" },
        { ok: true, text: "third time" },
      ],
      onTranscript,
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(controller.getSnapshot().autoRetryScheduled).toBe(true);
    expect(scheduler.pending).toHaveLength(1);
    expect(scheduler.pending[0]!.delayMs).toBe(10); // base * 2^0

    await scheduler.runNext(); // auto-retry 1 fails
    expect(scheduler.pending[0]!.delayMs).toBe(20); // base * 2^1

    await scheduler.runNext(); // auto-retry 2 succeeds
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(onTranscript).toHaveBeenCalledWith("third time");
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("stops auto-retrying after the max and holds for manual retry", async () => {
    const onError = vi.fn();
    const { controller, scheduler } = makeController({
      outcomes: [
        { ok: false, retryable: true, message: "fail-1" },
        { ok: false, retryable: true, message: "fail-2" },
        { ok: false, retryable: true, message: "fail-3" },
      ],
      onError,
    });
    await captureAndFinish(controller);
    await flushPromises();
    await scheduler.runNext();
    await scheduler.runNext();
    expect(scheduler.pending).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(controller.getSnapshot().autoRetryScheduled).toBe(false);
    expect(controller.getSnapshot().errorMessage).toBe("fail-3");
    expect(onError).toHaveBeenCalledWith("fail-3");
  });

  it("does not auto-retry a non-retryable failure", async () => {
    const onError = vi.fn();
    const { controller, scheduler, transcribe } = makeController({
      outcomes: [{ ok: false, retryable: false, message: "unsupported audio" }],
      onError,
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(scheduler.pending).toHaveLength(0);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(onError).toHaveBeenCalledWith("unsupported audio");
  });

  it("supports a one-click manual retry after failure", async () => {
    const onTranscript = vi.fn();
    const { controller } = makeController({
      outcomes: [
        { ok: false, retryable: false, message: "nope" },
        { ok: true, text: "manual win" },
      ],
      onTranscript,
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(controller.getSnapshot().phase).toBe("failed");
    await controller.retry();
    await flushPromises();
    expect(onTranscript).toHaveBeenCalledWith("manual win");
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("discards a failed recording and returns to idle", async () => {
    const { controller, persistence } = makeController({
      outcomes: [{ ok: false, retryable: false, message: "nope" }],
    });
    await captureAndFinish(controller);
    await flushPromises();
    expect(persistence.metas.size).toBe(1);
    await controller.discard();
    expect(persistence.metas.size).toBe(0);
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("recovers an interrupted recording from persistence on hydrate", async () => {
    const persistence = new InMemoryPersistence();
    await persistence.createRecording({
      id: "rec-prev",
      mimeType: "audio/webm",
      createdAt: 500,
      status: "recording", // interrupted mid-capture
      durationMs: 3000,
      sizeBytes: 10,
      autoRetriesUsed: 0,
      lastError: null,
    });
    await persistence.appendChunk("rec-prev", new Blob(["persisted-audio"]));

    const onTranscript = vi.fn();
    const { controller } = makeController({
      persistence,
      outcomes: [{ ok: true, text: "recovered" }],
      onTranscript,
    });
    await controller.hydrate();
    expect(controller.getSnapshot().phase).toBe("failed");
    expect(controller.getSnapshot().recordingId).toBe("rec-prev");
    expect(persistence.metas.get("rec-prev")?.status).toBe("failed");

    await controller.retry();
    await flushPromises();
    expect(onTranscript).toHaveBeenCalledWith("recovered");
    expect(controller.getSnapshot().phase).toBe("idle");
  });
});
