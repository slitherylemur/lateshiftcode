import { useCallback, useEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error?: string;
  readonly message?: string;
}

function isSilenceError(event: SpeechRecognitionErrorEventLike): boolean {
  const error = event.error?.toLowerCase().trim() ?? "";
  const message = event.message?.toLowerCase().trim() ?? "";
  return (
    error === "no-speech" ||
    error === "speech-timeout" ||
    message.includes("no speech") ||
    message.includes("speech timeout")
  );
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as SpeechRecognitionWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export interface BrowserSpeechRecognitionApi {
  readonly isSupported: boolean;
  readonly isListening: boolean;
  readonly elapsedMs: number;
  start(): void;
  stop(): void;
}

/** Browser-native dictation fallback for hosted clients paired to stock servers. */
export function useBrowserSpeechRecognition(options: {
  readonly onInsertTranscript: (text: string) => void;
  readonly onSessionEnd?: () => void;
  readonly disabled?: boolean;
}): BrowserSpeechRecognitionApi {
  const [isListening, setIsListening] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const startedAtRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRequestedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (restartTimeoutRef.current !== null) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    stopRequestedRef.current = true;
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (options.disabled === true || recognitionRef.current !== null) return;
    const Recognition = recognitionConstructor();
    if (Recognition === null) return;

    const recognition = new Recognition();
    // Safari frequently ends continuous recognition with `no-speech`. Short,
    // automatically restarted sessions are more reliable on iOS.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    transcriptRef.current = "";
    interimTranscriptRef.current = "";
    stopRequestedRef.current = false;
    recognitionRef.current = recognition;

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? "";
        if (result?.isFinal) finalText += text;
        else interimText += text;
      }
      transcriptRef.current += finalText;
      // WebKit often never promotes its last hypothesis to `isFinal` when the
      // user presses Stop. Preserve it so stopping dictation does not discard
      // everything the user just said.
      interimTranscriptRef.current = interimText;
    };
    recognition.onerror = (event) => {
      // Silence is not a failure: Safari ends the current recognition window
      // and `onend` starts a fresh one while the user is still recording.
      if (isSilenceError(event)) return;

      const permissionDenied =
        event.error === "not-allowed" || event.error === "service-not-allowed";
      stopRequestedRef.current = true;
      toastManager.add({
        type: "error",
        title: "Voice input failed",
        description: permissionDenied
          ? "Microphone permission was denied. Enable it in your browser settings to use voice input."
          : event.message || "Speech recognition stopped unexpectedly.",
      });
    };
    recognition.onend = () => {
      const transcript = `${transcriptRef.current} ${interimTranscriptRef.current}`.trim();
      if (!stopRequestedRef.current && !transcript) {
        restartTimeoutRef.current = setTimeout(() => {
          restartTimeoutRef.current = null;
          try {
            recognition.start();
          } catch {
            clearTimer();
            recognitionRef.current = null;
            setIsListening(false);
            toastManager.add({
              type: "error",
              title: "Voice input failed",
              description: "Could not restart speech recognition in this browser.",
            });
          }
        }, 200);
        return;
      }

      clearTimer();
      recognitionRef.current = null;
      setIsListening(false);
      transcriptRef.current = "";
      interimTranscriptRef.current = "";
      if (transcript) options.onInsertTranscript(transcript);
      // Restore through the composer's editor handle. document.activeElement
      // is frequently body on iOS after WebKit closes speech recognition.
      requestAnimationFrame(() => options.onSessionEnd?.());
    };

    try {
      recognition.start();
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setIsListening(true);
      intervalRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 250);
    } catch {
      recognitionRef.current = null;
      toastManager.add({
        type: "error",
        title: "Voice input failed",
        description: "Could not start speech recognition in this browser.",
      });
    }
  }, [clearTimer, options.disabled, options.onInsertTranscript, options.onSessionEnd]);

  useEffect(
    () => () => {
      stopRequestedRef.current = true;
      clearTimer();
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [clearTimer],
  );

  return {
    isSupported: recognitionConstructor() !== null,
    isListening,
    elapsedMs,
    start,
    stop,
  };
}
