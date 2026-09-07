"use client";

import type { StreamState } from "@/types/client";

// ── Inline text renderer ──────────────────────────────────────────────────────
// Converts AI markdown-lite output to React elements without a markdown library.
// Handles: ## headings, **bold** labels, - bullet items, plain paragraphs.

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-slate-900">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

function ClinicalText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="text-slate-700 text-sm leading-relaxed space-y-0.5">
      {lines.map((line, i) => {
        const trimmed = line.trim();

        if (!trimmed) return <div key={i} className="h-2" aria-hidden="true" />;

        if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) {
          const heading = trimmed.replace(/^#{2,3}\s+/, "");
          return (
            <h3
              key={i}
              className="text-xs font-semibold uppercase tracking-wider text-teal-700 mt-4 mb-1 pt-2 border-t border-slate-100 first:border-t-0 first:mt-0 first:pt-0"
            >
              {heading}
            </h3>
          );
        }

        if (trimmed.match(/^\*\*[^*]+:\*\*$/)) {
          const label = trimmed.slice(2, -2);
          return (
            <p key={i} className="font-semibold text-slate-800 mt-3 mb-0.5">
              {label}
            </p>
          );
        }

        if (trimmed.match(/^[-•*]\s/)) {
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="text-teal-500 mt-0.5 shrink-0" aria-hidden="true">
                •
              </span>
              <span>{renderInline(trimmed.slice(2))}</span>
            </div>
          );
        }

        return <p key={i}>{renderInline(trimmed)}</p>;
      })}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse" aria-hidden="true">
      {[70, 90, 55, 80, 65].map((w, i) => (
        <div
          key={i}
          className="h-3 bg-slate-200 rounded"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}

// ── Warning banners ───────────────────────────────────────────────────────────

function WarningBanners({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="space-y-2 mb-4" role="alert">
      {warnings.map((w, i) => (
        <div
          key={i}
          className="flex gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-amber-800 text-xs"
        >
          <span className="shrink-0 mt-0.5" aria-hidden="true">⚠</span>
          <span>{w}</span>
        </div>
      ))}
    </div>
  );
}

// ── Draft warning banner ──────────────────────────────────────────────────────

function DraftDisclaimer() {
  return (
    <div
      className="flex gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-amber-800 text-xs mb-3"
      role="alert"
      aria-live="polite"
    >
      <span className="shrink-0 mt-0.5" aria-hidden="true">⚠</span>
      <span>
        <strong className="font-semibold">AI-generated draft.</strong> Review and
        edit before confirming. This draft is based on documented information
        only. The doctor must verify all content before it enters the medical
        record.
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface ResponseAreaProps {
  state: StreamState;
  isDraft: boolean;
  draftText: string;
  onDraftChange: (text: string) => void;
  capabilityLabel: string;
}

export function ResponseArea({
  state,
  isDraft,
  draftText,
  onDraftChange,
  capabilityLabel,
}: ResponseAreaProps) {
  // Screen-reader announcement on completion.
  const srMessage =
    state.status === "done"
      ? `${capabilityLabel} complete.`
      : state.status === "loading" || state.status === "streaming"
        ? "Loading clinical information…"
        : state.status === "error"
          ? `Error: ${state.errorMessage ?? "An error occurred."}`
          : "";

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Screen reader live region */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {srMessage}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Idle / waiting state */}
        {state.status === "idle" && (
          <p className="text-sm text-slate-400 italic">
            Select a capability to generate clinical information.
          </p>
        )}

        {/* Loading state */}
        {state.status === "loading" && (
          <div aria-busy="true" aria-label="Loading clinical information">
            <LoadingSkeleton />
          </div>
        )}

        {/* Streaming — progressive text + cursor */}
        {state.status === "streaming" && (
          <div aria-busy="true" aria-label="Generating clinical information">
            <WarningBanners warnings={state.warnings} />
            {state.text ? (
              <div>
                <ClinicalText text={state.text} />
                <span className="streaming-cursor ml-0.5 text-teal-500" aria-hidden="true" />
              </div>
            ) : (
              <LoadingSkeleton />
            )}
          </div>
        )}

        {/* Done — non-draft: formatted read-only text */}
        {state.status === "done" && !isDraft && (
          <div>
            <WarningBanners warnings={state.warnings} />
            <ClinicalText text={state.text} />
          </div>
        )}

        {/* Done — draft: editable textarea */}
        {state.status === "done" && isDraft && (
          <div className="flex flex-col h-full">
            <DraftDisclaimer />
            <WarningBanners warnings={state.warnings} />
            <textarea
              className="flex-1 w-full min-h-[320px] p-3 text-sm text-slate-800 bg-white border border-slate-300 rounded-md resize-y font-mono leading-relaxed focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
              value={draftText}
              onChange={(e) => onDraftChange(e.target.value)}
              aria-label={`Draft ${capabilityLabel} — review and edit before confirming`}
              spellCheck={false}
            />
          </div>
        )}

        {/* Cancelled */}
        {state.status === "cancelled" && (
          <p className="text-sm text-slate-400 italic">Request cancelled.</p>
        )}

        {/* Error */}
        {state.status === "error" && (
          <div
            className="flex gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-md text-red-800 text-sm"
            role="alert"
          >
            <span className="shrink-0 mt-0.5 text-red-500" aria-hidden="true">✕</span>
            <span>{state.errorMessage ?? "An unexpected error occurred."}</span>
          </div>
        )}
      </div>
    </div>
  );
}
