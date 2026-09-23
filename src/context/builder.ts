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
  type RefractionEye,
  type VisualAcuityEye,
} from "@/lib/ppms-client";
import { matchGovtScheme, type GovtSchemeEntry } from "@/lib/govt-schemes";
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
        ? getVisits(token, patientRef, capability === "LAST_VISIT_SUMMARY" ? 2 : visitLimit === 0 ? 20 : visitLimit)
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

// Renders one eye's non-empty fields as "Label value, Label value, ...", or
// null if the eye has nothing documented. Shared shape for refraction and
// visual acuity — both are per-eye field bags with the same "only render
// what's present" rule as every other optional field in renderVisit.
function renderEyeFields(fields: [label: string, value: string | undefined][]): string | null {
  const parts = fields
    .filter((f): f is [string, string] => !!f[1])
    .map(([label, value]) => `${label} ${value}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function renderRefractionEye(eye: RefractionEye | undefined): string | null {
  if (!eye) return null;
  return renderEyeFields([
    ["Sph", eye.sph],
    ["Cyl", eye.cyl],
    ["Axis", eye.axis],
    ["Near Sph", eye.nearSph],
    ["VA", eye.va],
    ["Near VA", eye.nearVa],
    ["Method", eye.method],
  ]);
}

function renderVisualAcuityEye(eye: VisualAcuityEye | undefined): string | null {
  if (!eye) return null;
  return renderEyeFields([
    ["Unaided", eye.unaided],
    ["Pinhole", eye.pinhole],
    ["Best corrected", eye.bestCorrected],
    ["Near unaided", eye.nearUnaided],
    ["Near pinhole", eye.nearPinhole],
    ["Near best corrected", eye.nearBestCorrected],
  ]);
}

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

  if (visit.reportedMedications) lines.push(`Reported medications: ${visit.reportedMedications}`);

  if (visit.refraction) {
    const re = renderRefractionEye(visit.refraction.re);
    const le = renderRefractionEye(visit.refraction.le);
    const parts = [re && `RE: ${re}`, le && `LE: ${le}`].filter((p): p is string => !!p);
    if (parts.length > 0) lines.push(`Refraction: ${parts.join("; ")}`);
  }

  if (visit.visualAcuity) {
    const re = renderVisualAcuityEye(visit.visualAcuity.re);
    const le = renderVisualAcuityEye(visit.visualAcuity.le);
    const parts = [re && `RE: ${re}`, le && `LE: ${le}`].filter((p): p is string => !!p);
    if (parts.length > 0) {
      const method = visit.visualAcuity.testMethod ? `${visit.visualAcuity.testMethod} — ` : "";
      lines.push(`Visual Acuity: ${method}${parts.join("; ")}`);
    }
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
  if (visit.referralEnabled) {
    lines.push(`Referral: documented${visit.referralNote ? ` — ${visit.referralNote}` : ""}`);
  }
  if (visit.dispenseSummary) lines.push(`Dispense summary: ${visit.dispenseSummary}`);

  return lines.join("\n");
}

// ── Shared rendering ──────────────────────────────────────────────────────────
// Renders a FetchedContext into the context text and stats.
// Used by both buildPatientContext (per-capability) and buildConsolidatedContext.

function renderFetchedContext(
  fetched: FetchedContext,
  visitId: string,
): { text: string; stats: PatientContext["stats"]; matchedGovtScheme?: GovtSchemeEntry } {
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

  // ── SUB-TAB DOCUMENTATION STATUS (computed) ──────────────────────────────
  // Ground truth for REFRACTIVE_GUIDANCE's routing block — rendered here so
  // the model can see and cite it, but the validator (validateRefractiveGuidance
  // in validation/response.ts) checks the model's claims against the original
  // DocumentedFlags object (threaded separately via PatientContext.documented),
  // never against this rendering of it.
  if (fetched.currentVisit?.documented) {
    const d = fetched.currentVisit.documented;
    sections.push("\n=== SUB-TAB DOCUMENTATION STATUS (computed — do not recalculate) ===");
    sections.push(`Visual Acuity: ${d.visualAcuity ? "Documented" : "Not documented"}`);
    sections.push(`Refraction: ${d.refraction ? "Documented" : "Not documented"}`);
    sections.push(`Anterior Segment: ${d.anteriorSegment ? "Documented" : "Not documented"}`);
    sections.push(`Posterior Segment: ${d.posteriorSegment ? "Documented" : "Not documented"}`);
  }

  // ── APPLICABLE GOVT SCHEME (computed) ────────────────────────────────────
  // Ground truth for PLAN_GUIDANCE's Govt Scheme block — matched deterministically
  // in application code (matchGovtScheme), never by the model. Rendered here
  // so the model can copy it verbatim; the validator (validatePlanGuidance)
  // checks against the original GovtSchemeEntry object (threaded separately
  // via PatientContext.matchedGovtScheme), never against this rendering.
  // Absent entirely when no match was found — the prompt instructs the model
  // to omit the Govt Scheme block whenever this section isn't present.
  const matchedGovtScheme = fetched.currentVisit
    ? matchGovtScheme(fetched.currentVisit.diagnoses)
    : null;
  if (matchedGovtScheme) {
    sections.push("\n=== APPLICABLE GOVT SCHEME (computed — cite verbatim only) ===");
    sections.push(`Scheme: ${matchedGovtScheme.schemeName}`);
    sections.push(`Description: ${matchedGovtScheme.description}`);
    sections.push(`Eligibility: ${matchedGovtScheme.eligibilitySummary}`);
    sections.push(`Last verified: ${matchedGovtScheme.lastVerified}`);
  }

  // ── PREVIOUS VISITS ───────────────────────────────────────────────────────
  if (previousVisits.length > 0) {
    sections.push("\n=== PREVIOUS VISITS (newest first) ===");
    previousVisits.forEach((v, i) => {
      sections.push(renderVisit(v, `Visit V${i + 1} (${v.date})`));
    });
  }

  // ── VITAL TRENDS (application-computed) ───────────────────────────────────
  // Compute once and reuse for both the trends section and structured findings.
  const vitalTrends = allVisitsForEvidence.length >= 2
    ? extractVitalTrends(allVisitsForEvidence)
    : [];

  if (vitalTrends.length > 0) {
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
    const findings = extractClinicalFindings(
      allVisitsForEvidence,
      evidence.medicationDeltas,
      evidence.diagnosisDeltas,
      vitalTrends,
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
    visitsIncluded: (fetched.currentVisit ? 1 : 0) + fetched.visitHistory.length,
    appointmentsIncluded: fetched.appointments.length,
    timelineEventsIncluded: fetched.timeline.length,
    estimatedTokens: estimateTokens(text),
  };

  return { text, stats, matchedGovtScheme: matchedGovtScheme ?? undefined };
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

  const { text, stats, matchedGovtScheme } = renderFetchedContext(fetched, visitId);

  logger.info("context_built", {
    capability,
    durationMs: Date.now() - start,
    visitsIncluded: stats.visitsIncluded,
    appointmentsIncluded: stats.appointmentsIncluded,
    timelineEventsIncluded: stats.timelineEventsIncluded,
    estimatedTokens: stats.estimatedTokens,
  });

  const previous = fetched.visitHistory
    .filter((visit) => visit.visitId !== visitId)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    text: capability === "LAST_VISIT_SUMMARY"
      ? (previous ? renderVisit(previous, `Visit V1 (${previous.date})`) : "No previous visit documented.")
      : capability === "DIAGNOSIS_COMPARISON"
        ? (fetched.currentVisit ? renderVisit(fetched.currentVisit, "Current visit (V0)") : "No current visit documented.")
        : text,
    stats, visitId, documented: fetched.currentVisit?.documented, matchedGovtScheme,
    hasDocumentedDiagnosis: Boolean(fetched.currentVisit?.diagnoses.length),
    diagnosisComparisonText: fetched.currentVisit
      ? renderVisit(fetched.currentVisit, "Current visit (V0)") : "No current visit documented.",
    lastVisitText: previous ? renderVisit(previous, `Visit V1 (${previous.date})`) : "No previous visit documented.",
  };
}

// Fetches the union of all MVP capabilities' data needs in one Promise.all,
// then renders a single context text. Used by the consolidated generate endpoint.
export async function buildConsolidatedContext(args: {
  token: string;
  patientRef: string;
  visitId: string;
}): Promise<PatientContext> {
  const { token, patientRef, visitId } = args;
  const start = Date.now();

  let fetched: FetchedContext;
  try {
    // Fetch everything needed across all 7 consolidated capabilities at once:
    //   demographics: always
    //   currentVisit: PATIENT_SNAPSHOT, IMPORTANT_CHANGES, NOTE_ASSISTANCE, FOLLOW_UP_SUMMARY, DIFFERENTIAL_DIAGNOSIS
    //   visitHistory(3): capped at 3 (down from 6) to keep the consolidated
    //     request under the 8 000-token Groq free-tier TPM limit — the full
    //     8720-token request was causing HTTP 413 errors. 3 history visits is
    //     sufficient for IMPORTANT_CHANGES and PLAN_GUIDANCE; the clinical
    //     benefit of visits 4-6 does not outweigh "AI service unavailable".
    //   appointments(5): capped at 5 (down from 10) for the same reason.
    //   timeline: TIMELINE_SUMMARY
    // DIFFERENTIAL_DIAGNOSIS's own narrower data needs (see CAPABILITY_CONFIG)
    // are already a subset of this superset fetch, so no extra fetch is needed
    // to fold it in here.
    const [patient, currentVisit, visitHistory, appointments, timeline] = await Promise.all([
      getPatient(token, patientRef),
      getVisit(token, patientRef, visitId),
      getVisits(token, patientRef, 3),
      getAppointments(token, patientRef, 5),
      getTimeline(token, patientRef),
    ]);
    fetched = { patient, currentVisit, visitHistory, appointments, timeline };
  } catch (err) {
    const code = err instanceof CopilotError ? err.code : "INTERNAL_ERROR";
    logger.error("consolidated_context_fetch_failed", { code });
    throw err;
  }

  const { text, stats, matchedGovtScheme } = renderFetchedContext(fetched, visitId);

  logger.info("consolidated_context_built", {
    durationMs: Date.now() - start,
    visitsIncluded: stats.visitsIncluded,
    appointmentsIncluded: stats.appointmentsIncluded,
    timelineEventsIncluded: stats.timelineEventsIncluded,
    estimatedTokens: stats.estimatedTokens,
  });

  const previous = fetched.visitHistory
    .filter((visit) => visit.visitId !== visitId)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    text, stats, visitId, documented: fetched.currentVisit?.documented, matchedGovtScheme,
    hasDocumentedDiagnosis: Boolean(fetched.currentVisit?.diagnoses.length),
    diagnosisComparisonText: fetched.currentVisit
      ? renderVisit(fetched.currentVisit, "Current visit (V0)") : "No current visit documented.",
    lastVisitText: previous ? renderVisit(previous, `Visit V1 (${previous.date})`) : "No previous visit documented.",
  };
}
