import type { EnvironmentId } from "@t3tools/contracts";
import { Loader2Icon, MicIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { readEnvironmentSupportsTranscription } from "../state/entities";
import { useVoiceRecording } from "./useVoiceRecording";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export interface ComposerMicButtonProps {
  readonly environmentId: EnvironmentId;
  readonly onInsertTranscript: (text: string) => void;
  readonly disabled?: boolean;
}

/**
 * Voice-input control for the composer footer. Hidden entirely when the
 * environment server has no transcription credential configured (feature
 * detected via the environment descriptor capability) or when the browser
 * cannot record audio, so it never appears in a non-functional state.
 */
export function ComposerMicButton(props: ComposerMicButtonProps) {
  const disabled = props.disabled ?? false;
  const supported = readEnvironmentSupportsTranscription(props.environmentId);
  const voice = useVoiceRecording({
    onInsertTranscript: props.onInsertTranscript,
    disabled,
  });

  if (!supported || !voice.isSupported) {
    return null;
  }

  const { snapshot } = voice;

  if (snapshot.phase === "recording") {
    return (
      <div
        className="flex items-center gap-1.5 rounded-full border border-input bg-popover py-0.5 pr-0.5 pl-2"
        data-chat-composer-voice="recording"
      >
        <span
          className="size-2 shrink-0 animate-pulse rounded-full bg-red-500"
          aria-hidden="true"
        />
        <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {formatElapsed(voice.elapsedMs)}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          className="rounded-full"
          onClick={voice.stop}
          aria-label="Stop recording"
          title="Stop recording"
        >
          <SquareIcon className="size-3.5 fill-current" />
        </Button>
      </div>
    );
  }

  if (snapshot.phase === "transcribing") {
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        className="rounded-full"
        disabled
        aria-label="Transcribing recording"
        title="Transcribing…"
        data-chat-composer-voice="transcribing"
      >
        <Loader2Icon className="size-4 animate-spin" />
      </Button>
    );
  }

  if (snapshot.phase === "failed") {
    return (
      <div className="flex items-center gap-1" data-chat-composer-voice="failed">
        <Button
          size="sm"
          variant="destructive-outline"
          className="gap-1.5 rounded-full"
          onClick={voice.retry}
          disabled={snapshot.autoRetryScheduled}
          aria-label="Retry transcription"
          title={snapshot.errorMessage ?? "Retry transcription"}
        >
          {snapshot.autoRetryScheduled ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RotateCcwIcon className="size-3.5" />
          )}
          {snapshot.autoRetryScheduled ? "Retrying" : "Retry"}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="rounded-full"
          onClick={voice.discard}
          aria-label="Discard recording"
          title="Discard recording"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="rounded-full"
      onClick={() => {
        void voice.start();
      }}
      disabled={disabled}
      aria-label="Record voice message"
      title="Record voice message"
      data-chat-composer-voice="idle"
    >
      <MicIcon className="size-4" />
    </Button>
  );
}
