"use client";

import { useState, useCallback } from "react";
import type { StreamStatus } from "@/types/client";

interface ActionBarProps {
  status: StreamStatus;
  isDraft: boolean;
  draftConfirmed: boolean;
  text: string;
  onConfirmDraft: () => void;
  onRegenerate: () => void;
  onCancel: () => void;
}

export function ActionBar({
  status,
  isDraft,
  draftConfirmed,
  text,
  onConfirmDraft,
  onRegenerate,
  onCancel,
}: ActionBarProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available — silent fail (embedded iframe restriction).
    }
  }, [text]);

  // Show action bar only when there's something to act on.
  if (status === "idle" || status === "cancelled") return null;

  return (
    <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 flex items-center gap-2 flex-wrap">
      {/* Cancel — only while streaming/loading */}
      {(status === "loading" || status === "streaming") && (
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 transition-colors"
          aria-label="Cancel current request"
        >
          Cancel
        </button>
      )}

      {/* Copy — when done or error with text */}
      {(status === "done" || (status === "error" && text)) && (
        <button
          type="button"
          onClick={handleCopy}
          disabled={!text}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 transition-colors disabled:opacity-40"
          aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      )}

      {/* Regenerate — when done or error */}
      {(status === "done" || status === "error") && (
        <button
          type="button"
          onClick={onRegenerate}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 transition-colors"
          aria-label="Regenerate response"
        >
          Regenerate
        </button>
      )}

      {/* Confirm draft — draft capabilities only, when done and not yet confirmed */}
      {status === "done" && isDraft && (
        <button
          type="button"
          onClick={onConfirmDraft}
          disabled={draftConfirmed}
          className={[
            "px-4 py-1.5 text-xs font-semibold rounded-md transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400",
            draftConfirmed
              ? "bg-green-100 text-green-700 border border-green-300 cursor-default"
              : "bg-teal-600 text-white hover:bg-teal-700 active:bg-teal-800",
          ].join(" ")}
          aria-label={
            draftConfirmed
              ? "Draft confirmed and sent to PPMS"
              : "Confirm draft and send to PPMS for saving"
          }
          aria-disabled={draftConfirmed}
        >
          {draftConfirmed ? "Draft Confirmed ✓" : "Confirm Draft"}
        </button>
      )}

      {/* Spacer + context note for draft capabilities */}
      {status === "done" && isDraft && !draftConfirmed && (
        <span className="ml-auto text-xs text-slate-400 italic hidden sm:block">
          Review and edit before confirming
        </span>
      )}
    </div>
  );
}
