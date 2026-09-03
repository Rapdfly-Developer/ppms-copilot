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
