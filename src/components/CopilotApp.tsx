"use client";

// Main Copilot application component — consolidated single-request architecture.
//
// Architecture:
//   - ONE AI request per visit (on session arrival or explicit Regenerate)
//   - Tab clicks change activeCapability only — zero additional AI calls
//   - All six sections served from in-memory result after initial generation
//
// State machine:
//   no-session → awaiting PPMS_INIT
//   session + idle/loading → generating all six sections
//   session + done → all tabs available instantly
//   session + token-expired → shows expired UI, requests re-issue
//
// Security:
//   - Token lives only in React state (memory), never persisted.
//   - Regenerate issues exactly one new consolidated request.
//   - Draft text is editable before confirmation — never auto-saved.

import { useState, useEffect, useRef, useCallback } from "react";
import { usePostMessage } from "@/hooks/usePostMessage";
import { useCopilotGenerate } from "@/hooks/useCopilotGenerate";
import { CapabilitySelector } from "@/components/CapabilitySelector";
import { ResponseArea } from "@/components/ResponseArea";
import { ActionBar } from "@/components/ActionBar";
import { CAPABILITY_CONFIG } from "@/capabilities";
import { MAX_TOKEN_LIFETIME_MS } from "@/lib/constants";
import type { Capability, StreamState, CopilotGenerateState, SectionOutcome } from "@/types/client";

// ── Capability → section key mapping ─────────────────────────────────────────

type SectionKey = "snapshot" | "previousVisits" | "timeline" | "attention" | "draftNote" | "followUp";

const CAPABILITY_TO_SECTION: Partial<Record<Capability, SectionKey>> = {
  PATIENT_SNAPSHOT: "snapshot",
  PREVIOUS_VISIT_SUMMARY: "previousVisits",
  TIMELINE_SUMMARY: "timeline",
  IMPORTANT_CHANGES: "attention",
  NOTE_ASSISTANCE: "draftNote",
  FOLLOW_UP_SUMMARY: "followUp",
};

// Converts the consolidated state + active capability into the StreamState
// shape that ResponseArea already understands — no changes needed to ResponseArea.
function toStreamState(
  copilotState: CopilotGenerateState,
  capability: Capability,
): StreamState {
  if (copilotState.status === "idle" || copilotState.status === "loading") {
    return {
      status: copilotState.status,
      text: "",
      warnings: [],
    };
  }

  if (copilotState.status === "error") {
    return {
      status: "error",
      text: "",
      warnings: [],
      errorMessage: copilotState.errorMessage,
      errorCode: copilotState.errorCode,
    };
  }

  // status === "done" — look up section
  const key = CAPABILITY_TO_SECTION[capability];
  if (!key) {
    return { status: "idle", text: "", warnings: [] };
  }

  const section: SectionOutcome = copilotState.data[key];
  if (!section.ok) {
    return {
      status: "error",
      text: "",
      warnings: [],
      errorMessage: section.errorMessage,
      errorCode: section.errorCode,
    };
  }

  const capConfig = CAPABILITY_CONFIG[capability];
  return {
    status: "done",
    text: section.text,
    warnings: section.warnings,
    doneMeta: {
      capability,
      producesDraft: capConfig.producesDraft,
      draftType: capConfig.draftType,
    },
  };
}

// ── Status dot ────────────────────────────────────────────────────────────────

function StatusDot({
  status,
  isExpired,
  hasSession,
}: {
  status: CopilotGenerateState["status"];
  isExpired: boolean;
  hasSession: boolean;
}) {
  const color = isExpired
    ? "bg-red-400"
    : !hasSession
      ? "bg-gray-400"
      : status === "loading"
        ? "bg-amber-400 animate-pulse"
        : status === "error"
          ? "bg-red-400"
          : status === "done"
            ? "bg-teal-500"
            : "bg-gray-400";

  const label = isExpired
    ? "Session expired"
    : !hasSession
      ? "Awaiting session"
      : status === "loading"
        ? "Generating"
        : status === "error"
          ? "Error"
          : status === "done"
            ? "Ready"
            : "Awaiting session";

  return (
    <div
      className="flex items-center gap-1.5"
      role="status"
      aria-label={`Status: ${label}`}
    >
      <span className={`w-2 h-2 rounded-full ${color}`} aria-hidden="true" />
      <span className="text-xs text-gray-500">{label}</span>
    </div>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header({
  status,
  isExpired,
  hasSession,
}: {
  status: CopilotGenerateState["status"];
  isExpired: boolean;
  hasSession: boolean;
}) {
  return (
    <header
      className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-white"
      role="banner"
    >
      <div className="flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 text-teal-500 shrink-0"
          aria-hidden="true"
        >
          <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
        </svg>
        <span className="text-sm font-semibold text-gray-800 tracking-tight">
          AI Clinical Copilot
        </span>
      </div>
      <StatusDot status={status} isExpired={isExpired} hasSession={hasSession} />
    </header>
  );
}

// ── Context bar ───────────────────────────────────────────────────────────────

function ContextBar({ patientRef, visitId }: { patientRef: string; visitId: string }) {
  return (
    <div className="shrink-0 px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-1.5 text-xs text-gray-500 overflow-hidden">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        className="w-3.5 h-3.5 shrink-0 text-gray-400"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"
        />
      </svg>
      <span className="truncate font-medium text-gray-700">{patientRef}</span>
      <span className="text-gray-300 shrink-0">·</span>
      <span className="truncate text-gray-400">current visit</span>
    </div>
  );
}

// ── Waiting-for-session state ─────────────────────────────────────────────────

function WaitingForSession() {
  return (
    <main
      className="flex-1 flex flex-col items-center justify-center text-center p-8"
      aria-label="Waiting for PPMS session"
    >
      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mb-3">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-5 h-5 text-gray-400"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-gray-600 mb-1">Awaiting patient context</p>
      <p className="text-xs text-gray-400">Open a patient visit in PPMS to activate the AI Copilot.</p>
    </main>
  );
}

// ── Session-expired state ─────────────────────────────────────────────────────

function SessionExpired({ onRefresh }: { onRefresh: () => void }) {
  return (
    <main
      className="flex-1 flex flex-col items-center justify-center text-center p-8"
      role="alert"
      aria-label="Session expired"
    >
      <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center mb-3">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-5 h-5 text-red-400"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-gray-700 mb-1">Session expired</p>
      <p className="text-xs text-gray-400 mb-4">
        Return to the patient visit to refresh your session.
      </p>
      <button
        type="button"
        onClick={onRefresh}
        className="px-4 py-2 text-xs font-medium bg-teal-600 text-white rounded-md hover:bg-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 transition-colors"
      >
        Request New Session
      </button>
    </main>
  );
}

// ── Footer disclaimer ─────────────────────────────────────────────────────────

function Disclaimer() {
  return (
    <p className="shrink-0 text-center text-xs text-teal-600 px-4 py-2 border-t border-gray-100 bg-white leading-snug">
      The Copilot provides decision support only. It does not diagnose, prescribe, or make
      treatment decisions, and it never writes to the EMR. All clinical decisions remain yours.
    </p>
  );
}

// ── CopilotApp ────────────────────────────────────────────────────────────────

export default function CopilotApp() {
  const { session, confirmDraft, requestTokenRefresh } = usePostMessage();
  const { state, generate, regenerate, cancel } = useCopilotGenerate();
  const [activeCapability, setActiveCapability] = useState<Capability>("PATIENT_SNAPSHOT");
  const [draftText, setDraftText] = useState("");
  const [draftConfirmed, setDraftConfirmed] = useState(false);

  const sessionStartedRef = useRef<number | null>(null);

  // Trigger ONE consolidated generation when a new session arrives.
  // The ref guard prevents double-firing from React Strict Mode re-execution.
  useEffect(() => {
    if (!session) return;
    if (session.initiatedAt === sessionStartedRef.current) return;
    sessionStartedRef.current = session.initiatedAt;

    // New visit → reset UI state, then generate all six sections at once.
    setActiveCapability("PATIENT_SNAPSHOT");
    setDraftText("");
    setDraftConfirmed(false);
    generate(session.token, session.visitId);
  }, [session?.initiatedAt, generate]);

  // Sync draft text when generation completes for the active draft capability.
  useEffect(() => {
    if (state.status !== "done") return;
    const sectionKey = CAPABILITY_TO_SECTION[activeCapability];
    if (!sectionKey) return;
    const capConfig = CAPABILITY_CONFIG[activeCapability];
    if (!capConfig.producesDraft) return;
    const section = state.data[sectionKey];
    if (section.ok && section.text) {
      setDraftText(section.text);
    }
  }, [state.status, activeCapability]);

  // Periodic re-render to detect expiry.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [session]);

  const isExpired =
    session !== null && Date.now() - session.initiatedAt >= MAX_TOKEN_LIFETIME_MS;

  const capConfig = CAPABILITY_CONFIG[activeCapability];
  const isLoading = state.status === "loading";

  // Tab clicks ONLY change the active tab — no AI calls.
  const selectCapability = useCallback(
    (cap: Capability) => {
      if (isLoading) return;
      setActiveCapability(cap);
      setDraftText("");
      setDraftConfirmed(false);

      // If switching to a draft capability and data is already loaded, sync text.
      if (state.status === "done") {
        const sectionKey = CAPABILITY_TO_SECTION[cap];
        const newCapConfig = CAPABILITY_CONFIG[cap];
        if (sectionKey && newCapConfig.producesDraft) {
          const section = state.data[sectionKey];
          if (section.ok && section.text) {
            setDraftText(section.text);
          }
        }
      }
    },
    [isLoading, state],
  );

  const handleConfirmDraft = useCallback(() => {
    if (!session || !draftText || draftConfirmed) return;
    const draftType = capConfig.draftType;
    if (!draftType) return;
    confirmDraft(session.visitId, draftType, draftText);
    setDraftConfirmed(true);
  }, [session, draftText, draftConfirmed, capConfig.draftType, confirmDraft]);

  // Regenerate: one new consolidated request for ALL six sections.
  const handleRegenerate = useCallback(() => {
    if (!session) return;
    setDraftText("");
    setDraftConfirmed(false);
    regenerate(session.token, session.visitId);
  }, [session, regenerate]);

  // Derive per-tab stream state from the consolidated result (no AI calls).
  const sectionStreamState = toStreamState(state, activeCapability);

  return (
    <div className="flex flex-col h-screen bg-white overflow-hidden">
      <Header
        status={state.status}
        isExpired={isExpired}
        hasSession={session !== null}
      />

      {!session ? (
        <WaitingForSession />
      ) : isExpired ? (
        <SessionExpired onRefresh={requestTokenRefresh} />
      ) : (
        <>
          <ContextBar patientRef={session.patientRef} visitId={session.visitId} />

          <CapabilitySelector
            active={activeCapability}
            onSelect={selectCapability}
            disabled={isLoading}
          />

          {/* Capability description */}
          <div className="shrink-0 px-4 pt-3 pb-2">
            <h2 className="text-xs font-semibold text-gray-800">{capConfig.label}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{capConfig.description}</p>
          </div>

          <ResponseArea
            state={sectionStreamState}
            isDraft={capConfig.producesDraft}
            draftText={draftText}
            onDraftChange={setDraftText}
            capabilityLabel={capConfig.label}
          />

          <ActionBar
            status={sectionStreamState.status}
            isDraft={capConfig.producesDraft}
            draftConfirmed={draftConfirmed}
            text={
              capConfig.producesDraft && sectionStreamState.status === "done"
                ? draftText
                : sectionStreamState.text
            }
            onConfirmDraft={handleConfirmDraft}
            onRegenerate={handleRegenerate}
            onCancel={cancel}
          />

          <Disclaimer />
        </>
      )}
    </div>
  );
}
