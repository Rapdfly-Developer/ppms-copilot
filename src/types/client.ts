// Client-safe types for the Copilot UI.
// No server-only imports permitted in this file.

export type Capability =
  | "PATIENT_SNAPSHOT"
  | "PREVIOUS_VISIT_SUMMARY"
  | "HISTORY_SUMMARY"
  | "TIMELINE_SUMMARY"
  | "IMPORTANT_CHANGES"
  | "NOTE_ASSISTANCE"
  | "FOLLOW_UP_SUMMARY"
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
