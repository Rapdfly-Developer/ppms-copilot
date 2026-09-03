// Clinical context builder.
//
// Fetches the minimal data each capability declares, then renders it into
// a deterministic plain-text block that gets sent to the AI model.
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
      // Demographics always fetched (lightweight, required by all capabilities)
      getPatient(token, patientRef),

      // Current visit — only when the capability declares it
      includes.currentVisit
        ? getVisit(token, patientRef, visitId)
        : Promise.resolve(undefined),

      // Visit history — only when declared; limit 0 means fetch 20 (max)
      includes.visitHistory
        ? getVisits(token, patientRef, visitLimit === 0 ? 20 : visitLimit)
        : Promise.resolve([] as VisitDTO[]),

      // Appointments — only when declared
      includes.appointments
        ? getAppointments(token, patientRef, 10)
        : Promise.resolve([]),

      // Timeline — only when declared
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

  // Render — identity fields intentionally excluded
  const safe = toSafePatientSummary(fetched.patient);
  const sections: string[] = [];

  sections.push("=== PATIENT DEMOGRAPHICS ===");
  sections.push(renderDemographics(safe));

  if (fetched.currentVisit) {
    sections.push("\n=== CURRENT VISIT ===");
    sections.push(renderVisit(fetched.currentVisit, "Current visit"));
  }

  const previousVisits = fetched.visitHistory.filter((v) => v.visitId !== visitId);
  if (previousVisits.length > 0) {
    sections.push("\n=== VISIT HISTORY (newest first) ===");
    previousVisits.forEach((v, i) => {
      sections.push(renderVisit(v, `Visit ${i + 1}`));
    });
  }

  if (fetched.timeline.length > 0) {
    sections.push("\n=== CLINICAL TIMELINE ===");
    for (const event of fetched.timeline) {
      const detail = event.detail ? ` — ${event.detail}` : "";
      sections.push(`${event.date}: [${event.kind}] ${event.label}${detail}`);
    }
  }

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
