import { PaperclipIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "../components/ui/button";

export interface ComposerAttachButtonProps {
  /** Hands the chosen files to the composer's existing image-attachment path. */
  readonly onFilesSelected: (files: File[]) => void;
  readonly disabled?: boolean;
}

/**
 * Mobile file / photo picker for the composer.
 *
 * Upstream only accepts attachments through paste and drag-and-drop, neither of
 * which exists on a phone, so on iOS and Android there is no way at all to
 * attach a photo. This button opens the platform picker:
 *
 *   * iOS  — "Photo Library", "Take Photo or Video", and "Choose File" (Files app)
 *   * Android — the system photo picker / document picker
 *
 * The input is `accept="image/*"` on purpose: the stock T3 server only accepts
 * image attachments on a turn, so offering arbitrary documents here would
 * produce an attachment the server rejects. The button is deliberately always
 * visible (not mobile-only) — a desktop user gets a normal file dialog.
 */
export function ComposerAttachButton(props: ComposerAttachButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        // The picker fires no event when the user cancels, so the value is
        // cleared after each selection instead — otherwise re-picking the same
        // photo twice in a row is a no-op.
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) {
            props.onFilesSelected(files);
          }
        }}
        data-chat-composer-attach="input"
      />
      <Button
        size="icon-sm"
        variant="ghost"
        className="rounded-full"
        disabled={props.disabled ?? false}
        onClick={() => inputRef.current?.click()}
        aria-label="Attach a photo or file"
        title="Attach a photo or file"
        data-chat-composer-attach="button"
      >
        <PaperclipIcon className="size-4" />
      </Button>
    </>
  );
}
