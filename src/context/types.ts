import type { Capability } from "@/capabilities";
import type { PatientDTO, VisitDTO, AppointmentDTO, TimelineEventDTO } from "@/lib/ppms-client";

// Raw data fetched from PPMS Core APIs before context building
export type FetchedContext = {
  patient: PatientDTO;
  currentVisit?: VisitDTO;
  visitHistory: VisitDTO[];
  appointments: AppointmentDTO[];
  timeline: TimelineEventDTO[];
};

// Statistics about the built context — used for audit and UI indicator
export type ContextStats = {
  visitsIncluded: number;
  appointmentsIncluded: number;
  timelineEventsIncluded: number;
  estimatedTokens: number;
};

// The output of the context builder — what gets sent (via prompt) to the AI
export type PatientContext = {
  text: string;       // clinical context text; fenced in <patient_record> by PromptBuilder
  stats: ContextStats;
  visitId: string;    // kept for audit correlation — NOT included in the AI context text
  // Deliberately no patientRef, patientId, or name — those stay in the token
};

// Arguments passed to buildPatientContext()
export type BuildContextArgs = {
  token: string;        // forwarded to PPMS Core API calls
  capability: Capability;
  patientRef: string;   // comes from the decoded (but PPMS-verified) plugin token
  visitId: string;      // comes from the decoded plugin token
  question?: string;    // optional doctor question (QUESTION capability)
};

// ── Clinical evidence layer ──────────────────────────────────────────────────
// Pre-computed from structured DTO data before sending to the AI.
// This surfaces objective clinical signals without requiring the LLM to derive them.

export type MedicationDelta = {
  drugName: string;
  change: "added" | "removed" | "continued";
  visitDate: string;
  previousVisitDate?: string;
};

export type DiagnosisDelta = {
  description: string;
  change: "new" | "confirmed" | "resolved" | "unchanged";
  laterality?: string;
  visitDate: string;
};

export type ClinicalEvidence = {
  // Medication changes between consecutive visits
  medicationDeltas: MedicationDelta[];
  // Diagnosis status changes across visits
  diagnosisDeltas: DiagnosisDelta[];
  // All unique medications ever documented (for full medication history)
  uniqueMedications: string[];
  // All unique investigations ordered across visits
  uniqueInvestigations: string[];
  // Surgeries documented across visits
  surgeryHistory: Array<{ name: string; visitDate: string }>;
  // Follow-up dates documented across visits
  followUpHistory: Array<{ date: string; visitDate: string; advice?: string }>;
};
