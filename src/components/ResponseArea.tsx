"use client";

import React, { useMemo } from "react";
import type { StreamState } from "@/types/client";

// ── Parser ────────────────────────────────────────────────────────────────────
// Converts AI markdown-lite text into typed section+item data for structured
// rendering. Handles: ## headings, **bold:** fields, **bold** names (Dx),
// Confidence:/Source: metadata, - bullets, and plain paragraphs.

type SectionItem =
  | { kind: "field";      label: string; value: string }
  | { kind: "bullet";     text: string }
  | { kind: "subheading"; text: string }
  | { kind: "meta";       label: string; value: string }
  | { kind: "text";       text: string };

interface ParsedSection {
  heading: string;
  items: SectionItem[];
}

function parseAIText(raw: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("## ")) {
      current = { heading: line.slice(3).trim(), items: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("### ")) {
      if (!current) { current = { heading: "", items: [] }; sections.push(current); }
      current.items.push({ kind: "subheading", text: line.slice(4).trim() });
      continue;
    }
    if (!line) continue;
    if (!current) { current = { heading: "", items: [] }; sections.push(current); }

    // Confidence: / Source: metadata (differential dx format)
    if (/^confidence:\s*/i.test(line)) {
      current.items.push({ kind: "meta", label: "Confidence", value: line.replace(/^confidence:\s*/i, "").trim() });
      continue;
    }
    if (/^source:\s*/i.test(line)) {
      current.items.push({ kind: "meta", label: "Source", value: line.replace(/^source:\s*/i, "").trim() });
      continue;
    }

    // **Label:** value  or  **Name** (standalone diagnosis name)
    const boldColon = line.match(/^\*\*([^*]+?):\*\*\s*(.*)$/);
    if (boldColon) {
      current.items.push({ kind: "field", label: boldColon[1].trim(), value: boldColon[2].trim() });
      continue;
    }
    const boldName = line.match(/^\*\*([^*]+)\*\*$/);
    if (boldName) {
      current.items.push({ kind: "subheading", text: boldName[1].trim() });
      continue;
    }

    // Bullet: - • *
    const bullet = line.match(/^[-•*]\s+(.+)$/);
    if (bullet) {
      const content = bullet[1].trim();
      const bulletField = content.match(/^([A-Za-z][A-Za-z\s/()\-]{1,30}):\s+(.{1,})$/);
      if (
        bulletField &&
        bulletField[1].split(" ").length <= 5 &&
        !/^(none|no |not )/i.test(content)
      ) {
        current.items.push({ kind: "field", label: bulletField[1].trim(), value: bulletField[2].trim() });
      } else {
        current.items.push({ kind: "bullet", text: content });
      }
      continue;
    }

    // Plain "Label: value" (short label, max 5 words)
    const plainField = line.match(/^([A-Za-z][A-Za-z\s/()\-]{1,30}):\s+(.{1,})$/);
    if (plainField && plainField[1].split(" ").length <= 5) {
      current.items.push({ kind: "field", label: plainField[1].trim(), value: plainField[2].trim() });
      continue;
    }

    current.items.push({ kind: "text", text: line });
  }

  return sections.filter(s => s.items.length > 0 || s.heading);
}

// ── Inline bold renderer ──────────────────────────────────────────────────────

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**")
          ? <strong key={i} className="font-semibold text-slate-800">{p.slice(2, -2)}</strong>
          : <React.Fragment key={i}>{p}</React.Fragment>
      )}
    </>
  );
}

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({ section }: { section: ParsedSection }) {
  if (!section.items.length && !section.heading) return null;

  return (
    <div className="mb-4">
      {section.heading && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400 leading-none shrink-0">
            {section.heading}
          </span>
          <div className="flex-1 h-px bg-slate-150" style={{ background: "#e9ecf0" }} />
        </div>
      )}

      {section.items.length > 0 && (
        <div className="rounded-lg border border-slate-100 bg-white overflow-hidden">
          {section.items.map((item, idx) => {
            const borderClass = idx < section.items.length - 1
              ? "border-b border-slate-50"
              : "";

            switch (item.kind) {
              case "field":
                return (
                  <div key={idx} className={`flex items-start gap-3 px-3 py-2.5 ${borderClass}`}>
                    <span className="w-[116px] shrink-0 text-[11px] font-medium text-slate-400 leading-[1.6] pt-px">
                      {item.label}
                    </span>
                    <span className="flex-1 text-[12.5px] text-slate-800 leading-[1.6] break-words min-w-0">
                      {item.value
                        ? <InlineText text={item.value} />
                        : <span className="text-slate-300 italic">—</span>}
                    </span>
                  </div>
                );

              case "bullet":
                return (
                  <div key={idx} className={`flex items-start gap-2.5 px-3 py-2 ${borderClass}`}>
                    <span className="mt-[8px] h-[5px] w-[5px] rounded-full bg-teal-400 shrink-0 flex-none" />
                    <span className="flex-1 text-[12.5px] text-slate-700 leading-[1.6] break-words min-w-0">
                      <InlineText text={item.text} />
                    </span>
                  </div>
                );

              case "subheading":
                return (
                  <div key={idx} className={`px-3 py-2 bg-slate-50 ${borderClass}`}>
                    <span className="text-[11.5px] font-semibold text-teal-700">
                      {item.text}
                    </span>
                  </div>
                );

              case "meta":
                return (
                  <div key={idx} className={`flex items-center gap-3 px-3 py-1.5 ${borderClass}`}
                    style={{ background: "#f9fafb" }}>
                    <span className="w-[116px] shrink-0 text-[10.5px] font-medium text-slate-400">
                      {item.label}
                    </span>
                    <span className="flex-1 text-[11px] text-slate-500 italic">
                      {item.value}
                    </span>
                  </div>
                );

              case "text": {
                const isNone =
                  /^(none|no |not |—)/i.test(item.text) ||
                  item.text.toLowerCase().includes("not documented") ||
                  item.text.toLowerCase().includes("none documented");
                return (
                  <div key={idx} className={`px-3 py-2.5 ${borderClass}`}>
                    <span className={`text-[12.5px] leading-[1.6] break-words ${isNone ? "text-slate-400 italic" : "text-slate-700"}`}>
                      <InlineText text={item.text} />
                    </span>
                  </div>
                );
              }

              default:
                return null;
            }
          })}
        </div>
      )}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="p-4 space-y-5 animate-pulse">
      {[
        [75, 55, 85, 65],
        [90, 60, 70],
        [80, 50, 75, 60],
      ].map((widths, s) => (
        <div key={s}>
          <div className="h-2 w-20 rounded mb-3" style={{ background: "#e9ecf0" }} />
          <div className="rounded-lg border border-slate-100 bg-white overflow-hidden">
            {widths.map((w, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2.5 border-b border-slate-50 last:border-0">
                <div className="h-2.5 w-24 rounded shrink-0" style={{ background: "#f1f3f5" }} />
                <div className="h-2.5 rounded" style={{ width: `${w}%`, background: "#f1f3f5" }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Inline SVG icons (no lucide dependency) ───────────────────────────────────

function IconWarning() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 text-amber-500">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" /><path d="M12 17h.01" />
    </svg>
  );
}

function IconError() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 text-red-400">
      <circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" />
    </svg>
  );
}

// ── AI warning banner ─────────────────────────────────────────────────────────

function AIWarningBanner() {
  return (
    <div className="mx-4 mb-3 flex items-start gap-2.5 rounded-lg border border-amber-200 px-3.5 py-2.5"
      style={{ background: "#fffbeb" }} role="alert">
      <IconWarning />
      <div>
        <p className="text-[11.5px] font-semibold text-amber-800 leading-none mb-0.5">AI-generated draft</p>
        <p className="text-[11px] text-amber-700 leading-snug">
          Review and edit before confirming. Based on documented information only.
        </p>
      </div>
    </div>
  );
}

// ── Validation warning banners ────────────────────────────────────────────────

function WarningBanners({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="mx-4 mb-2 space-y-1.5" role="alert">
      {warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 rounded-md border border-amber-100 px-3 py-2"
          style={{ background: "#fffdf5" }}>
          <IconWarning />
          <span className="text-[11px] text-amber-700 leading-snug">{w}</span>
        </div>
      ))}
    </div>
  );
}

// ── Error state ───────────────────────────────────────────────────────────────

function ErrorState({ message }: { message: string }) {
  return (
    <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg border border-red-100 px-3.5 py-3"
      style={{ background: "#fff5f5" }} role="alert">
      <IconError />
      <div>
        <p className="text-[12px] font-medium text-red-700 leading-none mb-0.5">Unable to load</p>
        <p className="text-[11.5px] text-red-600 leading-snug">{message}</p>
      </div>
    </div>
  );
}

// ── Draft textarea ────────────────────────────────────────────────────────────

function DraftEditor({
  text,
  label,
  onChange,
}: {
  text: string;
  label: string;
  onChange: (t: string) => void;
}) {
  return (
    <div className="px-4 pb-4">
      <textarea
        value={text}
        onChange={e => onChange(e.target.value)}
        aria-label={`Draft ${label} — review and edit before confirming`}
        spellCheck
        className="w-full min-h-[320px] resize-y rounded-lg border border-slate-200 bg-white px-3.5 py-3 text-[12.5px] leading-relaxed text-slate-800 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent"
      />
    </div>
  );
}

// ── Streaming indicator ───────────────────────────────────────────────────────

function StreamingIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-4 py-2.5">
      {[0, 150, 300].map(delay => (
        <span
          key={delay}
          className="h-1.5 w-1.5 rounded-full bg-teal-400 animate-pulse"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
      <span className="text-[11px] text-slate-400 ml-1">Generating…</span>
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
  const textForParsing =
    state.status === "done" || state.status === "streaming" ? state.text : "";

  const sections = useMemo(() => parseAIText(textForParsing), [textForParsing]);

  // Screen-reader live region
  const srMessage =
    state.status === "done"
      ? `${capabilityLabel} ready.`
      : state.status === "loading" || state.status === "streaming"
        ? "Loading clinical information…"
        : state.status === "error"
          ? `Error: ${state.errorMessage ?? "An error occurred."}`
          : "";

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "#f8fafc" }}>
      {/* Screen-reader live region */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {srMessage}
      </div>

      {/* ── Idle ── */}
      {state.status === "idle" && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[11.5px] text-slate-400">Loading clinical data…</p>
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {state.status === "loading" && (
        <div aria-busy="true" aria-label="Loading clinical information">
          <LoadingSkeleton />
        </div>
      )}

      {/* ── Cancelled ── */}
      {state.status === "cancelled" && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[11.5px] text-slate-400 italic">Request cancelled.</p>
        </div>
      )}

      {/* ── Error ── */}
      {state.status === "error" && (
        <ErrorState message={state.errorMessage ?? "An unexpected error occurred."} />
      )}

      {/* ── Streaming / Done ── */}
      {(state.status === "streaming" || state.status === "done") && (
        <div
          className="flex-1 overflow-y-auto"
          aria-busy={state.status === "streaming"}
          aria-label={`${capabilityLabel} clinical information`}
        >
          {/* Show skeleton while streaming hasn't produced text yet */}
          {state.status === "streaming" && !state.text && (
            <LoadingSkeleton />
          )}

          {(state.text || state.status === "done") && (
            <>
              <div className="pt-3" />
              <WarningBanners warnings={state.warnings} />
              {isDraft && <AIWarningBanner />}

              {/* Draft tab: editable textarea */}
              {isDraft && state.status === "done" ? (
                <DraftEditor
                  text={draftText}
                  label={capabilityLabel}
                  onChange={onDraftChange}
                />
              ) : (
                /* Non-draft tabs: structured clinical sections */
                <div className="px-4 pb-4">
                  {sections.length === 0 ? (
                    <div className="rounded-lg border border-slate-100 bg-white px-4 py-6 text-center">
                      <p className="text-[12px] text-slate-400">
                        No information available for this visit.
                      </p>
                    </div>
                  ) : (
                    sections.map((s, i) => <SectionCard key={i} section={s} />)
                  )}
                  {state.status === "streaming" && <StreamingIndicator />}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
