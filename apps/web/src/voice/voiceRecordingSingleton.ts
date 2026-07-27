import { transcribeAudioViaServer } from "./transcriptionClient";
import { createIndexedDbRecordingPersistence } from "./voiceRecordingDb";
import { VoiceRecordingController } from "./voiceRecordingController";

interface VoiceRecordingHandlers {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

// A single controller is shared across composer mounts so a pending/failed
// recording is owned in exactly one place and survives navigation. The active
// composer registers where transcripts and errors should be delivered.
let handlers: VoiceRecordingHandlers = {
  onTranscript: () => {},
  onError: () => {},
};

export function setVoiceRecordingHandlers(next: VoiceRecordingHandlers): void {
  handlers = next;
}

export const voiceRecordingController = new VoiceRecordingController({
  persistence: createIndexedDbRecordingPersistence(),
  transcribe: transcribeAudioViaServer,
  onTranscript: (text) => {
    handlers.onTranscript(text);
  },
  onError: (message) => {
    handlers.onError(message);
  },
});
