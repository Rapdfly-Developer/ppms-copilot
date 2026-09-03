"use client";

// Main Copilot application component.
//
// State machine:
//   no-session → awaiting PPMS_INIT (no token yet)
//   session + idle → auto-starts PATIENT_SNAPSHOT
//   session + streaming/done → normal operation
//   session + token-expired → shows expired UI, requests re-issue
//
// Security:
//   - Token lives only in React state (memory), never persisted.
//   - Capability switches abort any in-flight request.
//   - Draft text is editable before confirmation — never auto-saved.

import { useState, useEffect, useRef, useCallback } from "react";
import { usePostMessage } from "@/hooks/usePostMessage";
import { useCopilotStream } from "@/hooks/useCopilotStream";
import { CapabilitySelector } from "@/components/CapabilitySelector";
import { ResponseArea } from "@/components/ResponseArea";
import { ActionBar } from "@/components/ActionBar";
import { CAPABILITY_CONFIG } from "@/capabilities";
import { MAX_TOKEN_LIFETIME_MS } from "@/lib/constants";
import type { Capability } from "@/types/client";

// ── Header ────────────────────────────────────────────────────────────────────

function Header({
  status,
  isExpired,
  hasSession,
}: {
  status: string;
  isExpired: boolean;
  hasSession: boolean;
}) {
  const statusColor = isExpired
    ? "bg-red-400"
    : !hasSession
      ? "bg-slate-500"
      : status === "streaming" || status === "loading"
        ? "bg-amber-400"
        : "bg-teal-400";

  const statusLabel = isExpired
    ? "Session expired"
    : !hasSession
      ? "Awaiting session"
      : status === "streaming" || status === "loading"
        ? "Generating"
        : status === "error"
          ? "Error"
          : status === "done"
            ? "Ready"
            : "Ready";

  return (
    <header
      className="shrink-0 bg-slate-900 px-4 py-3 flex items-center justify-between"
      role="banner"
    >
      <div className="flex items-center gap-2.5">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-5 h-5 text-teal-400"
          aria-hidden="true"
        >
          <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
        </svg>
        <h1 className="text-sm font-semibold text-white tracking-tight">
          PPMS AI Copilot
        </h1>
      </div>
      <div
        className="flex items-center gap-1.5"
        aria-label={`Status: ${statusLabel}`}
        role="status"
      >
        <span
          className={`w-2 h-2 rounded-full ${statusColor} ${
            status === "loading" || status === "streaming" ? "animate-pulse" : ""
          }`}
          aria-hidden="true"
        />
        <span className="text-xs text-slate-400">{statusLabel}</span>
      </div>
    </header>
  );
}

// ── Waiting-for-session state ─────────────────────────────────────────────────

function WaitingForSession() {
  return (
    <main
      className="flex-1 flex flex-col items-center justify-center text-center p-8"
      aria-label="Waiting for PPMS session"
    >
      <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mb-4">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-6 h-6 text-slate-400"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-slate-300 mb-1">
        Awaiting patient context
      </p>
      <p className="text-xs text-slate-500">
        Open a patient visit in PPMS to activate the AI Copilot.
      </p>
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
      <div className="w-12 h-12 rounded-full bg-red-900/30 flex items-center justify-center mb-4">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-6 h-6 text-red-400"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-slate-300 mb-1">Session expired</p>
      <p className="text-xs text-slate-500 mb-4">
        The session token has expired. Return to the patient visit to refresh.
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

// ── CopilotApp ────────────────────────────────────────────────────────────────

export default function CopilotApp() {
  const { session, confirmDraft, requestTokenRefresh } = usePostMessage();
  const { state, start, cancel, reset } = useCopilotStream();
  const [activeCapability, setActiveCapability] = useState<Capability>("PATIENT_SNAPSHOT");
  const [draftText, setDraftText] = useState("");
  const [draftConfirmed, setDraftConfirmed] = useState(false);

  // Track session start to detect new sessions without dependency loops.
  const sessionStartedRef = useRef<number | null>(null);

  // Auto-start PATIENT_SNAPSHOT when a new session arrives.
  useEffect(() => {
    if (!session) return;
    if (session.initiatedAt === sessionStartedRef.current) return;
    sessionStartedRef.current = session.initiatedAt;

    setActiveCapability("PATIENT_SNAPSHOT");
    setDraftText("");
    setDraftConfirmed(false);
    start("PATIENT_SNAPSHOT", session.token);
  }, [session?.initiatedAt, start]);

  // Sync draft text when streaming completes for a draft capability.
  useEffect(() => {
    if (state.status === "done" && state.doneMeta?.producesDraft && state.text) {
      setDraftText(state.text);
    }
  }, [state.status]);

  // Periodic re-render to detect expiry without polling.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [session]);

  const isExpired =
    session !== null && Date.now() - session.initiatedAt >= MAX_TOKEN_LIFETIME_MS;

  const capConfig = CAPABILITY_CONFIG[activeCapability];

  const selectCapability = useCallback(
    (cap: Capability) => {
      if (!session || state.status === "loading" || state.status === "streaming") return;
      cancel();
      setActiveCapability(cap);
      setDraftText("");
      setDraftConfirmed(false);
      start(cap, session.token);
    },
    [session, state.status, cancel, start],
  );

  const handleConfirmDraft = useCallback(() => {
    if (!session || !draftText || draftConfirmed) return;
    const draftType = capConfig.draftType;
    if (!draftType) return;
    confirmDraft(session.visitId, draftType, draftText);
    setDraftConfirmed(true);
  }, [session, draftText, draftConfirmed, capConfig.draftType, confirmDraft]);

  const handleRegenerate = useCallback(() => {
    if (!session) return;
    setDraftText("");
    setDraftConfirmed(false);
    reset();
    start(activeCapability, session.token);
  }, [session, activeCapability, reset, start]);

  const isStreaming =
    state.status === "loading" || state.status === "streaming";

  return (
    <div className="flex flex-col h-screen bg-slate-900 overflow-hidden">
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
        <div className="flex flex-1 overflow-hidden">
          <CapabilitySelector
            active={activeCapability}
            onSelect={selectCapability}
            disabled={isStreaming}
          />

          <div className="flex flex-1 flex-col overflow-hidden bg-slate-50">
            {/* Capability heading */}
            <div className="shrink-0 px-5 pt-4 pb-3 border-b border-slate-200 bg-white">
              <h2 className="text-sm font-semibold text-slate-900">
                {capConfig.label}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {capConfig.description}
              </p>
            </div>

            <ResponseArea
              state={state}
              isDraft={capConfig.producesDraft}
              draftText={draftText}
              onDraftChange={setDraftText}
              capabilityLabel={capConfig.label}
            />

            <ActionBar
              status={state.status}
              isDraft={capConfig.producesDraft}
              draftConfirmed={draftConfirmed}
              text={capConfig.producesDraft && state.status === "done" ? draftText : state.text}
              onConfirmDraft={handleConfirmDraft}
              onRegenerate={handleRegenerate}
              onCancel={cancel}
            />
          </div>
        </div>
      )}
    </div>
  );
}
