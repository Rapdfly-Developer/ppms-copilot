// Clinical context builder.
//
// Fetches the minimal data each capability declares, then renders it into
// a deterministic plain-text block that gets sent to the AI model.
//
// Sections produced (capability-dependent):
//   PATIENT — demographics (PII-safe)
//   CURRENT VISIT — full structured current visit
//   PREVIOUS VISITS — structured previous visit records
//   MEDICATION HISTORY — aggregated across all visits
//   INVESTIGATION HISTORY — unique tests ordered across visits
//   FOLLOW-UP HISTORY — follow-up dates and advice across visits
//   CLINICAL EVIDENCE — pre-computed medication/diagnosis changes
//   CLINICAL TIMELINE — event timeline
//   APPOINTMENTS — upcoming appointments
//
// Identity invariant: patient name, UDID, doctorId, and hospitalId must
// NEVER appear in the output text. The builder refers to the patient as
// "the patient" throughout. The toSafePatientSummary() call is the
// structural guard that enforces this.

import { CAPABILITY_CONFIG } from "@/capabilities";
import type { Capability } from "@/capabilities";
import { CopilotError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  getPatient,
  getVisits,
  getVisit,
  getAppointments,
  getTimeline,
  type VisitDTO,
} from "@/lib/ppms-client";
import { toSafePatientSummary, estimateTokens } from "./pii";
import {
  extractClinicalEvidence,
  extractClinicalFindings,
  extractVitalTrends,
  renderClinicalEvidence,
  renderClinicalFindings,
  renderVisitReferenceGuide,
  renderVitalTrends,
} from "./evidence";
import type { PatientContext, BuildContextArgs, FetchedContext } from "./types";

// ── Data fetcher ──────────────────────────────────────────────────────────────

async function fetchContext(
  token: string,
  capability: Capability,
  patientRef: string,
  visitId: string,
): Promise<FetchedContext> {
  const { includes, visitLimit } = CAPABILITY_CONFIG[capability];

  const [patient, currentVisit, visitHistory, appointments, timeline] =
    await Promise.all([
      getPatient(token, patientRef),

      includes.currentVisit
        ? getVisit(token, patientRef, visitId)
        : Promise.resolve(undefined),

      includes.visitHistory
        ? getVisits(token, patientRef, visitLimit === 0 ? 20 : visitLimit)
        : Promise.resolve([] as VisitDTO[]),

      includes.appointments
        ? getAppointments(token, patientRef, 10)
        : Promise.resolve([]),

      includes.timeline
        ? getTimeline(token, patientRef)
        : Promise.resolve([]),
    ]);

  return { patient, currentVisit, visitHistory, appointments, timeline };
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderDemographics(s: ReturnType<typeof toSafePatientSummary>): string {
  return [
    `Patient: ${s.ageAndSex}`,
    `Clinical category: ${s.category}`,
    `Chief complaint: ${s.chiefComplaint}`,
    `Occupation: ${s.occupation}`,
    `PPMS patient since: ${s.registeredYear}`,
  ].join("\n");
}

function renderVisit(visit: VisitDTO, label: string): string {
  const lines: string[] = [
    `--- ${label} (${visit.date}, ${visit.visitType}) ---`,
  ];

  if (visit.chiefComplaint) lines.push(`Chief complaint: ${visit.chiefComplaint}`);
  if (visit.hpi) lines.push(`HPI: ${visit.hpi}`);
  if (visit.pastMedicalHistory) lines.push(`Past medical history: ${visit.pastMedicalHistory}`);

  if (visit.nkda) {
    lines.push("Allergies: NKDA");
  } else if (visit.allergies) {
    lines.push(`Allergies: ${visit.allergies}`);
  }

  if (visit.vitals) {
    const v = visit.vitals;
    const parts: string[] = [];
    if (v.bp) parts.push(`BP ${v.bp}`);
    if (v.pulse) parts.push(`Pulse ${v.pulse}`);
    if (v.temperature) parts.push(`Temp ${v.temperature}`);
    if (v.weight) parts.push(`Weight ${v.weight}`);
    if (parts.length > 0) lines.push(`Vitals: ${parts.join(", ")}`);
  }

  if (visit.diagnoses.length > 0) {
    lines.push("Diagnoses:");
    for (const d of visit.diagnoses) {
      const status = d.confirmed ? "confirmed" : d.provisional ? "provisional" : d.status;
      const lat = d.laterality ? ` (${d.laterality})` : "";
      const icd = d.icd10Code ? ` [${d.icd10Code}]` : "";
      lines.push(`  - ${d.description}${lat}${icd} [${status}]`);
    }
  }

  if (visit.medications.length > 0) {
    lines.push("Medications:");
    for (const m of visit.medications) {
      const lat = m.laterality ? ` (${m.laterality})` : "";
      lines.push(
        `  - ${m.drugName}${lat}: ${m.dosage} ${m.frequency} for ${m.duration} via ${m.route}`,
      );
      if (m.instructions) lines.push(`    Instructions: ${m.instructions}`);
    }
  }

  if (visit.investigations.length > 0) {
    lines.push("Investigations:");
    for (const i of visit.investigations) {
      const lat = i.laterality ? ` (${i.laterality})` : "";
      lines.push(
        `  - ${i.testName}${lat} [${i.category}, ${i.status}, ${i.priority} priority]`,
      );
      if (i.notes) lines.push(`    Notes: ${i.notes}`);
    }
  }

  if (visit.adviseNotes) lines.push(`Advice: ${visit.adviseNotes}`);
  if (visit.followUpDate) lines.push(`Follow-up date: ${visit.followUpDate}`);
  if (visit.surgeryAdvised && visit.advisedSurgeryName) {
    lines.push(`Surgery advised: ${visit.advisedSurgeryName}`);
  }

  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function buildPatientContext(
  args: BuildContextArgs,
): Promise<PatientContext> {
  const { token, capability, patientRef, visitId } = args;
  const start = Date.now();

  let fetched: FetchedContext;
  try {
    fetched = await fetchContext(token, capability, patientRef, visitId);
  } catch (err) {
    const code = err instanceof CopilotError ? err.code : "INTERNAL_ERROR";
    logger.error("context_fetch_failed", { capability, code });
    throw err;
  }

  const safe = toSafePatientSummary(fetched.patient);
  const sections: string[] = [];

  // ── PATIENT ───────────────────────────────────────────────────────────────
  sections.push("=== PATIENT ===");
  sections.push(renderDemographics(safe));

  // All visits combined (current + previous), newest-first, for evidence/trend computation
  const previousVisits = fetched.visitHistory.filter((v) => v.visitId !== visitId);
  const allVisitsForEvidence: VisitDTO[] = [
    ...(fetched.currentVisit ? [fetched.currentVisit] : []),
    ...previousVisits,
  ];

  // ── VISIT REFERENCE GUIDE ─────────────────────────────────────────────────
  // Emitted at top so the AI can cite visit dates as evidence sources.
  if (allVisitsForEvidence.length >= 1) {
    const refGuide = renderVisitReferenceGuide(allVisitsForEvidence);
    if (refGuide) {
      sections.push("\n=== VISIT REFERENCE GUIDE ===");
      sections.push(refGuide);
    }
  }

  // ── CURRENT VISIT ─────────────────────────────────────────────────────────
  if (fetched.currentVisit) {
    sections.push("\n=== CURRENT VISIT (V0) ===");
    sections.push(renderVisit(fetched.currentVisit, "Current visit (V0)"));
  }

  // ── PREVIOUS VISITS ───────────────────────────────────────────────────────
  if (previousVisits.length > 0) {
    sections.push("\n=== PREVIOUS VISITS (newest first) ===");
    previousVisits.forEach((v, i) => {
      sections.push(renderVisit(v, `Visit V${i + 1} (${v.date})`));
    });
  }

  // ── VITAL TRENDS (application-computed) ───────────────────────────────────
  if (allVisitsForEvidence.length >= 2) {
    const vitalTrends = extractVitalTrends(allVisitsForEvidence);
    const vitalText = renderVitalTrends(vitalTrends);
    if (vitalText.trim()) {
      sections.push("\n=== VITAL SIGN TRENDS (computed — do not recalculate) ===");
      sections.push(vitalText);
    }
  }

  // ── CLINICAL EVIDENCE (pre-computed) ──────────────────────────────────────
  if (allVisitsForEvidence.length >= 1) {
    const evidence = extractClinicalEvidence(allVisitsForEvidence);
    const evidenceText = renderClinicalEvidence(evidence);
    if (evidenceText.trim()) {
      sections.push("\n=== CLINICAL EVIDENCE (pre-computed from structured record) ===");
      sections.push(evidenceText);
    }

    // ── STRUCTURED CLINICAL FINDINGS ────────────────────────────────────────
    const vitalTrendsForFindings = extractVitalTrends(allVisitsForEvidence);
    const findings = extractClinicalFindings(
      allVisitsForEvidence,
      evidence.medicationDeltas,
      evidence.diagnosisDeltas,
      vitalTrendsForFindings,
    );
    const findingsText = renderClinicalFindings(findings);
    if (findingsText.trim()) {
      sections.push("\n=== STRUCTURED CLINICAL FINDINGS (cite these directly) ===");
      sections.push(findingsText);
    }
  }

  // ── CLINICAL TIMELINE ─────────────────────────────────────────────────────
  if (fetched.timeline.length > 0) {
    sections.push("\n=== CLINICAL TIMELINE ===");
    for (const event of fetched.timeline) {
      const detail = event.detail ? ` — ${event.detail}` : "";
      sections.push(`${event.date}: [${event.kind}] ${event.label}${detail}`);
    }
  }

  // ── APPOINTMENTS ──────────────────────────────────────────────────────────
  if (fetched.appointments.length > 0) {
    sections.push("\n=== APPOINTMENTS ===");
    for (const appt of fetched.appointments) {
      sections.push(
        `${appt.dateTime}: ${appt.visitType} at ${appt.hospitalName} [${appt.status}]`,
      );
    }
  }

  const text = sections.join("\n");
  const stats = {
    visitsIncluded:
      (fetched.currentVisit ? 1 : 0) + fetched.visitHistory.length,
    appointmentsIncluded: fetched.appointments.length,
    timelineEventsIncluded: fetched.timeline.length,
    estimatedTokens: estimateTokens(text),
  };

  logger.info("context_built", {
    capability,
    durationMs: Date.now() - start,
    visitsIncluded: stats.visitsIncluded,
    appointmentsIncluded: stats.appointmentsIncluded,
    timelineEventsIncluded: stats.timelineEventsIncluded,
    estimatedTokens: stats.estimatedTokens,
  });

  return { text, stats, visitId };
}
