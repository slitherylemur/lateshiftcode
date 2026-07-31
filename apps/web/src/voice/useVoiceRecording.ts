import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { isIndexedDbAvailable } from "./voiceRecordingDb";
import { setVoiceRecordingHandlers, voiceRecordingController } from "./voiceRecordingSingleton";
import type { VoiceRecordingSnapshot } from "./voiceRecordingTypes";

// Hard cap so a forgotten recording cannot grow unbounded (also well under the
// server's 25 MB payload ceiling for typical Opus bitrates).
const MAX_RECORDING_MS = 10 * 60 * 1000;

// Compressed formats the OpenAI transcription API accepts, in preference order.
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

function pickSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export interface VoiceRecordingApi {
  readonly snapshot: VoiceRecordingSnapshot;
  readonly elapsedMs: number;
  readonly isSupported: boolean;
  start(): Promise<void>;
  stop(): void;
  retry(): void;
  discard(): void;
}

/**
 * React binding over the shared {@link voiceRecordingController}. Owns the
 * browser capture concerns — microphone permission, MediaRecorder lifecycle,
 * elapsed timer, and the max-duration cap — and forwards chunks/results to the
 * controller, which owns persistence, transcription, and retries.
 */
export function useVoiceRecording(options: {
  onInsertTranscript: (text: string) => void;
  disabled?: boolean;
}): VoiceRecordingApi {
  const snapshot = useSyncExternalStore(
    voiceRecordingController.subscribe,
    voiceRecordingController.getSnapshot,
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setVoiceRecordingHandlers({
      onTranscript: options.onInsertTranscript,
      onError: (message) => {
        toastManager.add({ type: "error", title: "Transcription failed", description: message });
      },
    });
  }, [options.onInsertTranscript]);

  useEffect(() => {
    // Recover any recording left behind by a crashed/closed session.
    void voiceRecordingController.hydrate();
  }, []);

  const clearTimers = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (maxTimeoutRef.current !== null) {
      clearTimeout(maxTimeoutRef.current);
      maxTimeoutRef.current = null;
    }
  }, []);

  const teardownStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const stop = useCallback(() => {
    clearTimers();
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") {
      recorder.stop();
    }
  }, [clearTimers]);

  const start = useCallback(async () => {
    if (options.disabled === true || recorderRef.current !== null) {
      return;
    }
    if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
      toastManager.add({
        type: "error",
        title: "Microphone unavailable",
        description: "This browser does not support audio recording.",
      });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      const description =
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission was denied. Enable it in your browser settings to use voice input."
          : name === "NotFoundError"
            ? "No microphone was found on this device."
            : "Could not access the microphone.";
      toastManager.add({ type: "error", title: "Microphone unavailable", description });
      return;
    }

    const mimeType = pickSupportedMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType === undefined ? undefined : { mimeType });
    } catch {
      recorder = new MediaRecorder(stream);
    }
    streamRef.current = stream;
    recorderRef.current = recorder;

    const effectiveMime = recorder.mimeType || mimeType || "audio/webm";
    await voiceRecordingController.beginCapture(effectiveMime);

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        void voiceRecordingController.pushChunk(event.data);
      }
    });
    recorder.addEventListener(
      "stop",
      () => {
        clearTimers();
        const durationMs = Date.now() - startedAtRef.current;
        teardownStream();
        void voiceRecordingController.finishCapture(durationMs);
      },
      { once: true },
    );
    recorder.addEventListener(
      "error",
      () => {
        clearTimers();
        teardownStream();
        toastManager.add({
          type: "error",
          title: "Recording error",
          description: "Recording stopped unexpectedly.",
        });
      },
      { once: true },
    );

    startedAtRef.current = Date.now();
    setElapsedMs(0);
    // A timeslice makes MediaRecorder emit chunks periodically, so audio is
    // persisted as it is captured rather than only at stop.
    recorder.start(1000);
    intervalRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
    maxTimeoutRef.current = setTimeout(() => {
      stop();
    }, MAX_RECORDING_MS);
  }, [options.disabled, clearTimers, teardownStream, stop]);

  const retry = useCallback(() => {
    void voiceRecordingController.retry();
  }, []);

  const discard = useCallback(() => {
    void voiceRecordingController.discard();
  }, []);

  useEffect(
    () => () => {
      clearTimers();
    },
    [clearTimers],
  );

  return {
    snapshot,
    elapsedMs,
    isSupported: isIndexedDbAvailable() && typeof MediaRecorder !== "undefined",
    start,
    stop,
    retry,
    discard,
  };
}
