// Clinical evidence extractor.
//
// Pre-computes structured clinical signals from raw VisitDTOs before sending
// context to the AI. This surfaces objective patterns (medication changes,
// diagnosis changes, surgery history) without relying on the LLM to derive them
// from unstructured notes — reducing hallucination and improving precision.
//
// PII rules: visitId and dates are allowed; patient name and doctorId are never
// referenced here (they come from PatientDTO which is handled by pii.ts).

import type { VisitDTO } from "@/lib/ppms-client";
import type { ClinicalEvidence, MedicationDelta, DiagnosisDelta } from "./types";

// ── Medication delta extraction ───────────────────────────────────────────────

function extractMedicationDeltas(visits: VisitDTO[]): MedicationDelta[] {
  if (visits.length < 2) return [];

  const deltas: MedicationDelta[] = [];
  // visits are newest-first; compare each visit to the previous one
  for (let i = 0; i < visits.length - 1; i++) {
    const current = visits[i];
    const previous = visits[i + 1];

    const currentDrugs = new Set(current.medications.map((m) => m.drugName.toLowerCase().trim()));
    const previousDrugs = new Set(previous.medications.map((m) => m.drugName.toLowerCase().trim()));

    // Newly added in current vs previous
    for (const drug of currentDrugs) {
      if (!previousDrugs.has(drug)) {
        const med = current.medications.find((m) => m.drugName.toLowerCase().trim() === drug);
        deltas.push({
          drugName: med?.drugName ?? drug,
          change: "added",
          visitDate: current.date,
          previousVisitDate: previous.date,
        });
      }
    }

    // Removed from current (was in previous but not current)
    for (const drug of previousDrugs) {
      if (!currentDrugs.has(drug)) {
        const med = previous.medications.find((m) => m.drugName.toLowerCase().trim() === drug);
        deltas.push({
          drugName: med?.drugName ?? drug,
          change: "removed",
          visitDate: current.date,
          previousVisitDate: previous.date,
        });
      }
    }
  }

  return deltas;
}

// ── Diagnosis delta extraction ────────────────────────────────────────────────

function extractDiagnosisDeltas(visits: VisitDTO[]): DiagnosisDelta[] {
  if (visits.length === 0) return [];

  const deltas: DiagnosisDelta[] = [];
  // Track seen diagnoses by description (lowercased) to detect first-appearance
  const seenDiagnoses = new Map<string, { provisional: boolean; confirmed: boolean }>();

  // Process oldest-first to track progression
  const chronological = [...visits].reverse();

  for (const visit of chronological) {
    for (const dx of visit.diagnoses) {
      const key = dx.description.toLowerCase().trim();
      const prev = seenDiagnoses.get(key);

      if (!prev) {
        // First time seeing this diagnosis
        deltas.push({
          description: dx.description,
          change: "new",
          laterality: dx.laterality,
          visitDate: visit.date,
        });
        seenDiagnoses.set(key, { provisional: dx.provisional, confirmed: dx.confirmed });
      } else if (!prev.confirmed && dx.confirmed) {
        // Changed from provisional to confirmed
        deltas.push({
          description: dx.description,
          change: "confirmed",
          laterality: dx.laterality,
          visitDate: visit.date,
        });
        seenDiagnoses.set(key, { provisional: dx.provisional, confirmed: dx.confirmed });
      }
    }
  }

  return deltas;
}

// ── Unique medications and investigations ─────────────────────────────────────

function extractUniqueMedications(visits: VisitDTO[]): string[] {
  const seen = new Set<string>();
  for (const visit of visits) {
    for (const med of visit.medications) {
      seen.add(med.drugName.trim());
    }
  }
  return [...seen].sort();
}

function extractUniqueInvestigations(visits: VisitDTO[]): string[] {
  const seen = new Set<string>();
  for (const visit of visits) {
    for (const inv of visit.investigations) {
      seen.add(inv.testName.trim());
    }
  }
  return [...seen].sort();
}

// ── Surgery history ───────────────────────────────────────────────────────────

function extractSurgeryHistory(
  visits: VisitDTO[],
): Array<{ name: string; visitDate: string }> {
  const result: Array<{ name: string; visitDate: string }> = [];
  for (const visit of visits) {
    if (visit.surgeryAdvised && visit.advisedSurgeryName) {
      result.push({ name: visit.advisedSurgeryName, visitDate: visit.date });
    }
  }
  return result;
}

// ── Follow-up history ─────────────────────────────────────────────────────────

function extractFollowUpHistory(
  visits: VisitDTO[],
): Array<{ date: string; visitDate: string; advice?: string }> {
  const result: Array<{ date: string; visitDate: string; advice?: string }> = [];
  for (const visit of visits) {
    if (visit.followUpDate) {
      result.push({
        date: visit.followUpDate,
        visitDate: visit.date,
        advice: visit.adviseNotes,
      });
    }
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function extractClinicalEvidence(
  allVisits: VisitDTO[], // combined: [currentVisit, ...visitHistory] newest-first
): ClinicalEvidence {
  return {
    medicationDeltas: extractMedicationDeltas(allVisits),
    diagnosisDeltas: extractDiagnosisDeltas(allVisits),
    uniqueMedications: extractUniqueMedications(allVisits),
    uniqueInvestigations: extractUniqueInvestigations(allVisits),
    surgeryHistory: extractSurgeryHistory(allVisits),
    followUpHistory: extractFollowUpHistory(allVisits),
  };
}

// ── Evidence renderer (for context text) ─────────────────────────────────────

export function renderClinicalEvidence(evidence: ClinicalEvidence): string {
  const lines: string[] = [];

  if (evidence.medicationDeltas.length > 0) {
    lines.push("MEDICATION CHANGES (between consecutive visits):");
    for (const d of evidence.medicationDeltas) {
      const from = d.previousVisitDate ? ` (from ${d.previousVisitDate} to ${d.visitDate})` : ` (${d.visitDate})`;
      lines.push(`  - ${d.change.toUpperCase()}: ${d.drugName}${from}`);
    }
  }

  if (evidence.diagnosisDeltas.length > 0) {
    lines.push("DIAGNOSIS CHANGES:");
    for (const d of evidence.diagnosisDeltas) {
      const lat = d.laterality ? ` [${d.laterality}]` : "";
      lines.push(`  - ${d.change.toUpperCase()}: ${d.description}${lat} (${d.visitDate})`);
    }
  }

  if (evidence.uniqueMedications.length > 0) {
    lines.push(`MEDICATION HISTORY (all documented): ${evidence.uniqueMedications.join(", ")}`);
  }

  if (evidence.uniqueInvestigations.length > 0) {
    lines.push(`INVESTIGATION HISTORY (all ordered): ${evidence.uniqueInvestigations.join(", ")}`);
  }

  if (evidence.surgeryHistory.length > 0) {
    lines.push("SURGERY HISTORY:");
    for (const s of evidence.surgeryHistory) {
      lines.push(`  - ${s.name} (advised on ${s.visitDate})`);
    }
  }

  if (evidence.followUpHistory.length > 0) {
    lines.push("FOLLOW-UP HISTORY:");
    for (const f of evidence.followUpHistory) {
      const advice = f.advice ? ` — ${f.advice}` : "";
      lines.push(`  - Follow-up: ${f.date} (from visit ${f.visitDate})${advice}`);
    }
  }

  return lines.join("\n");
}
