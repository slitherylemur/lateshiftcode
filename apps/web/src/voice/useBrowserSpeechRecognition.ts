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
  readonly disabled?: boolean;
}): BrowserSpeechRecognitionApi {
  const [isListening, setIsListening] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");
  const startedAtRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (options.disabled === true || recognitionRef.current !== null) return;
    const Recognition = recognitionConstructor();
    if (Recognition === null) return;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    transcriptRef.current = "";
    recognitionRef.current = recognition;

    recognition.onresult = (event) => {
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) finalText += result[0]?.transcript ?? "";
      }
      transcriptRef.current += finalText;
    };
    recognition.onerror = (event) => {
      const permissionDenied =
        event.error === "not-allowed" || event.error === "service-not-allowed";
      toastManager.add({
        type: "error",
        title: "Voice input failed",
        description: permissionDenied
          ? "Microphone permission was denied. Enable it in your browser settings to use voice input."
          : event.message || "Speech recognition stopped unexpectedly.",
      });
    };
    recognition.onend = () => {
      clearTimer();
      recognitionRef.current = null;
      setIsListening(false);
      const transcript = transcriptRef.current.trim();
      transcriptRef.current = "";
      if (transcript) options.onInsertTranscript(transcript);
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
  }, [clearTimer, options.disabled, options.onInsertTranscript]);

  useEffect(
    () => () => {
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
