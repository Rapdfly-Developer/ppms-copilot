// PII filtering utilities.
//
// The primary guard against PII reaching the AI model is structural:
// the context builder never includes patient name, UDID, patientId, or
// doctorId in the context text. This module provides the safe representation
// types and helpers that enforce that contract.

import type { PatientDTO } from "@/lib/ppms-client";

// Safe patient representation — identity fields stripped.
// This is the only patient data structure that may be included in context text.
export type SafePatientSummary = {
  ageAndSex: string;      // e.g. "42-year-old male"
  category: string;       // e.g. "Glaucoma"
  chiefComplaint: string;
  occupation: string;
  registeredYear: string; // year only — not full date
};

// Convert a PatientDTO to a safe summary that can appear in AI context.
// Fields omitted: name, udid, patientId, registeredOn (full date).
export function toSafePatientSummary(patient: PatientDTO): SafePatientSummary {
  let registeredYear: string;
  try {
    registeredYear = new Date(patient.registeredOn).getFullYear().toString();
  } catch {
    registeredYear = "unknown";
  }

  return {
    ageAndSex: `${patient.age}-year-old ${patient.sex.toLowerCase()}`,
    category: patient.category,
    chiefComplaint: patient.complaint,
    occupation: patient.occupation,
    registeredYear,
  };
}

// Rough token estimation: 1 token ≈ 4 characters (conservative for English medical text)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Assertion for test use: verify a string does not contain known PII markers.
// Does NOT run in production — the structural guard is the primary defence.
export function assertNoPii(
  text: string,
  knownName: string,
  knownUdid: string,
): void {
  if (knownName && text.includes(knownName)) {
    throw new Error(`PII leak: patient name found in context text`);
  }
  if (knownUdid && text.includes(knownUdid)) {
    throw new Error(`PII leak: patient UDID found in context text`);
  }
}
