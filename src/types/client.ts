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

// Structured view of one exam-guidance segment block — the same two blocks
// validateExamGuidance() already parsed and approved, not a second independent
// parse. EXAM_GUIDANCE is on-demand only (not part of CopilotData/the
// consolidated call) — this travels through DoneMeta.examGuidanceSections on
// the standalone /api/copilot/stream path instead, then out to PPMS Core via
// the PLUGIN_EXAM_GUIDANCE_RESULT postMessage.
export type ExamGuidanceSection = {
  segment: "Anterior Segment" | "Posterior Segment";
  documented: string;
  associatedFindingsNotDocumented: string;
};

// Structured view of REFRACTIVE_GUIDANCE's result — the same three blocks
// validateRefractiveGuidance() already parsed, verified, and approved, not a
// second independent parse. On-demand only, same transport shape as
// EXAM_GUIDANCE: travels through DoneMeta.refractiveGuidanceResult on the
// standalone /api/copilot/stream path, then out via the
// PLUGIN_REFRACTIVE_GUIDANCE_RESULT postMessage.
//
// The four `*Documented` booleans on `routing` are the exact DocumentedFlags
// values the server verified the model's routing claims against — not a
// re-parse of the model's text. PPMS Core can trust them directly.
export type RefractiveEyeGuidance = {
  eye: "Right Eye" | "Left Eye";
  documented: string;
  interpretation: string;
};

export type RefractiveRoutingGuidance = {
  visualAcuityDocumented: boolean;
  refractionDocumented: boolean;
  anteriorSegmentDocumented: boolean;
  posteriorSegmentDocumented: boolean;
  guidance: string;
};

export type RefractiveGuidanceResult = {
  eyes: RefractiveEyeGuidance[]; // always [Right Eye, Left Eye], in that order
  routing: RefractiveRoutingGuidance;
};

// Structured view of PLAN_GUIDANCE's result — the same blocks
// validatePlanGuidance() already parsed, verified, and approved, not a
// second independent parse. Unlike EXAM_GUIDANCE/REFRACTIVE_GUIDANCE this
// capability IS part of the eager consolidated call — travels through
// SectionOutcome.planGuidanceResult, same as differentialDiagnosisItems.
//
// `govtScheme` is present only when a confident match existed AND the
// model's citation exactly matched it field-for-field — never a partial or
// AI-composed entry. Its absence means "no confident match", not an error.
export type GovtSchemeCitation = {
  schemeName: string;
  description: string;
  eligibilitySummary: string;
  lastVerified: string;
};

export type PlanGuidanceResult = {
  documentedProgression: string;
  comfortingGuidance: string;
  govtScheme?: GovtSchemeCitation;
};

export type SectionOutcome =
  | {
      ok: true;
      text: string;
      warnings: string[];
      differentialDiagnosisItems?: DifferentialDiagnosisItem[];
      planGuidanceResult?: PlanGuidanceResult;
    }
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
  planGuidance: SectionOutcome;
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
  | "EXAM_GUIDANCE"
  | "REFRACTIVE_GUIDANCE"
  | "PLAN_GUIDANCE"
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
  // Populated only for the EXAM_GUIDANCE capability once validated — the same
  // structured blocks validateExamGuidance() parsed server-side.
  examGuidanceSections?: ExamGuidanceSection[];
  // Populated only for the REFRACTIVE_GUIDANCE capability once validated —
  // the same structured result validateRefractiveGuidance() parsed and
  // ground-truth-verified server-side.
  refractiveGuidanceResult?: RefractiveGuidanceResult;
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
