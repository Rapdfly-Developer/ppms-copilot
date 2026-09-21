// Client-safe types for the Copilot UI.
// No server-only imports permitted in this file.

// ── Consolidated generate types ───────────────────────────────────────────────

// Structured view of one differential-diagnosis consideration — the same
// blocks validateDifferentialDiagnosis() already parsed and approved, not a
// second independent parse of the raw text. Confidence is exactly "Low" or
// "Moderate" by construction (see validation/response.ts's parseConsiderationBlock —
// the regex that finds the Confidence line only ever matches those two
// words). Sent to PPMS Core via the PLUGIN_DIFFERENTIAL_UPDATE postMessage
// for the persistent cross-tab differential-diagnosis card.
export type DifferentialDiagnosisItem = {
  name: string;
  confidence: "Low" | "Moderate";
  source?: string;
};

export type SectionOutcome =
  | { ok: true; text: string; warnings: string[]; differentialDiagnosisItems?: DifferentialDiagnosisItem[] }
  | { ok: false; errorCode: string; errorMessage: string };

export type CopilotData = {
  snapshot: SectionOutcome;
  previousVisits: SectionOutcome;
  timeline: SectionOutcome;
  attention: SectionOutcome;
  draftNote: SectionOutcome;
  followUp: SectionOutcome;
  differentialDiagnosis: SectionOutcome;
  medications: SectionOutcome;
  investigations: SectionOutcome;
  assessmentContext: SectionOutcome;
  suggestedQuestions: SectionOutcome;
};

export type CopilotGenerateState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; data: CopilotData; meta: Record<string, unknown> }
  | { status: "error"; errorCode: string; errorMessage: string };

export type Capability =
  | "PATIENT_SNAPSHOT"
  | "PREVIOUS_VISIT_SUMMARY"
  | "HISTORY_SUMMARY"
  | "TIMELINE_SUMMARY"
  | "IMPORTANT_CHANGES"
  | "NOTE_ASSISTANCE"
  | "FOLLOW_UP_SUMMARY"
  | "DIFFERENTIAL_DIAGNOSIS"
  | "MEDICATIONS_SUMMARY"
  | "INVESTIGATIONS_SUMMARY"
  | "ASSESSMENT_CONTEXT"
  | "SUGGESTED_QUESTIONS"
  | "QUESTION";

// Token stored only in memory — never in localStorage or cookies.
export interface CopilotSession {
  token: string;
  visitId: string;
  patientRef: string;
  initiatedAt: number; // Date.now()
}

export interface DoneMeta {
  capability?: string;
  producesDraft?: boolean;
  draftType?: "consultation_note" | "follow_up_summary";
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  contextStats?: {
    visitsIncluded: number;
    estimatedTokens: number;
    [key: string]: unknown;
  };
}

// Must exactly mirror the server-side NdjsonFrame union in src/service/copilot.ts.
export type ClientNdjsonFrame =
  | { type: "text"; text: string }
  | { type: "warning"; warnings: string[] }
  | { type: "done"; meta: DoneMeta }
  | { type: "error"; code: string; message: string; discard: boolean };

export type StreamStatus =
  | "idle"
  | "loading"
  | "streaming"
  | "done"
  | "error"
  | "cancelled";

export interface StreamState {
  status: StreamStatus;
  text: string;
  warnings: string[];
  errorMessage?: string;
  errorCode?: string;
  doneMeta?: DoneMeta;
}
