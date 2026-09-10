// Clinical evidence extractor.
//
// Pre-computes structured clinical signals from raw VisitDTOs BEFORE sending
// context to the AI. Two outputs:
//   1. ClinicalEvidence — raw deltas (medications, diagnoses, etc.)
//   2. ClinicalFinding[] — structured, categorised, importance-ranked findings
//   3. VitalTrend[] — numerical vital trends computed in application code
//
// This prevents the LLM from:
//   - overlooking longitudinal changes
//   - inventing numerical trends
//   - misidentifying the direction of change
//
// PII rules: visitId and dates are safe fields; patient name and doctorId are
// never referenced here.

import type { VisitDTO } from "@/lib/ppms-client";
import type {
  ClinicalEvidence,
  ClinicalFinding,
  MedicationDelta,
  DiagnosisDelta,
  VitalTrend,
  VitalDataPoint,
} from "./types";

// ── Visit reference label ─────────────────────────────────────────────────────
// V0 = current/most-recent visit, V1 = one before, etc.

export function visitRef(index: number): string {
  return `V${index}`;
}

// ── Medication delta extraction ───────────────────────────────────────────────

function extractMedicationDeltas(visits: VisitDTO[]): MedicationDelta[] {
  if (visits.length < 2) return [];

  const deltas: MedicationDelta[] = [];
  for (let i = 0; i < visits.length - 1; i++) {
    const current = visits[i];
    const previous = visits[i + 1];

    const currentDrugs = new Set(current.medications.map((m) => m.drugName.toLowerCase().trim()));
    const previousDrugs = new Set(previous.medications.map((m) => m.drugName.toLowerCase().trim()));

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
  const seen = new Map<string, { provisional: boolean; confirmed: boolean }>();
  const chronological = [...visits].reverse();

  for (const visit of chronological) {
    for (const dx of visit.diagnoses) {
      const key = dx.description.toLowerCase().trim();
      const prev = seen.get(key);

      if (!prev) {
        deltas.push({
          description: dx.description,
          change: "new",
          laterality: dx.laterality,
          visitDate: visit.date,
        });
        seen.set(key, { provisional: dx.provisional, confirmed: dx.confirmed });
      } else if (!prev.confirmed && dx.confirmed) {
        deltas.push({
          description: dx.description,
          change: "confirmed",
          laterality: dx.laterality,
          visitDate: visit.date,
        });
        seen.set(key, { provisional: dx.provisional, confirmed: dx.confirmed });
      }
    }
  }
  return deltas;
}

function extractUniqueMedications(visits: VisitDTO[]): string[] {
  const seen = new Set<string>();
  for (const v of visits) for (const m of v.medications) seen.add(m.drugName.trim());
  return [...seen].sort();
}

function extractUniqueInvestigations(visits: VisitDTO[]): string[] {
  const seen = new Set<string>();
  for (const v of visits) for (const i of v.investigations) seen.add(i.testName.trim());
  return [...seen].sort();
}

function extractSurgeryHistory(visits: VisitDTO[]): Array<{ name: string; visitDate: string }> {
  return visits
    .filter((v) => v.surgeryAdvised && v.advisedSurgeryName)
    .map((v) => ({ name: v.advisedSurgeryName!, visitDate: v.date }));
}

function extractFollowUpHistory(
  visits: VisitDTO[],
): Array<{ date: string; visitDate: string; advice?: string }> {
  return visits
    .filter((v) => v.followUpDate)
    .map((v) => ({ date: v.followUpDate!, visitDate: v.date, advice: v.adviseNotes }));
}

// ── Vital trend computation ───────────────────────────────────────────────────
// Parse structured vital strings into numeric values for trend computation.
// Only values we can reliably parse are included — no guessing.

function parseSystolic(bp?: string): number | undefined {
  if (!bp) return undefined;
  const m = bp.match(/^\s*(\d{2,3})\s*[/\\]\s*\d{2,3}/);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseDiastolic(bp?: string): number | undefined {
  if (!bp) return undefined;
  const m = bp.match(/^\s*\d{2,3}\s*[/\\]\s*(\d{2,3})/);
  return m ? parseInt(m[1], 10) : undefined;
}

function parsePulse(pulse?: string): number | undefined {
  if (!pulse) return undefined;
  const m = pulse.match(/(\d{2,3})/);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseWeight(weight?: string): number | undefined {
  if (!weight) return undefined;
  const m = weight.match(/(\d{2,3}(?:\.\d)?)/);
  return m ? parseFloat(m[1]) : undefined;
}

function computeDirection(points: VitalDataPoint[]): VitalTrend["direction"] | undefined {
  const nums = points.map((p) => p.numeric).filter((n): n is number => n !== undefined);
  if (nums.length < 2) return undefined;
  const latest = nums[0]; // newest (V0)
  const oldest = nums[nums.length - 1]; // oldest
  const diff = latest - oldest;
  if (Math.abs(diff) < 1) return "stable";
  // Check monotonicity in chronological order (oldest → newest)
  const chrono = [...nums].reverse();
  const allUp = chrono.slice(1).every((v, i) => v >= chrono[i]);
  const allDown = chrono.slice(1).every((v, i) => v <= chrono[i]);
  if (allUp) return "increased";
  if (allDown) return "decreased";
  return "variable";
}

function buildVitalTrend(
  vitalName: string,
  unit: string,
  visits: VisitDTO[],
  extractor: (v: VisitDTO) => string | undefined,
  numericParser: (raw: string) => number | undefined,
): VitalTrend | null {
  const points: VitalDataPoint[] = [];
  visits.forEach((v, i) => {
    const raw = extractor(v);
    if (raw?.trim()) {
      points.push({
        visitRef: visitRef(i),
        date: v.date,
        raw: raw.trim(),
        numeric: numericParser(raw),
      });
    }
  });

  if (points.length === 0) return null;

  const nums = points.map((p) => p.numeric).filter((n): n is number => n !== undefined);
  let delta: string | undefined;
  if (nums.length >= 2) {
    const diff = nums[0] - nums[nums.length - 1]; // newest minus oldest
    delta = diff >= 0 ? `+${diff}` : `${diff}`;
  }

  return {
    vital: vitalName,
    unit,
    points,
    direction: computeDirection(points),
    delta,
    first: points[points.length - 1]?.raw,
    latest: points[0]?.raw,
  };
}

export function extractVitalTrends(visits: VisitDTO[]): VitalTrend[] {
  const trends: VitalTrend[] = [];

  const bp = buildVitalTrend(
    "Blood Pressure (systolic)",
    "mmHg",
    visits,
    (v) => v.vitals?.bp,
    parseSystolic,
  );
  if (bp) trends.push(bp);

  const bpDiastolic = buildVitalTrend(
    "Blood Pressure (diastolic)",
    "mmHg",
    visits,
    (v) => v.vitals?.bp,
    parseDiastolic,
  );
  if (bpDiastolic) trends.push(bpDiastolic);

  const pulse = buildVitalTrend(
    "Pulse",
    "bpm",
    visits,
    (v) => v.vitals?.pulse,
    parsePulse,
  );
  if (pulse) trends.push(pulse);

  const weight = buildVitalTrend(
    "Weight",
    "kg",
    visits,
    (v) => v.vitals?.weight,
    parseWeight,
  );
  if (weight) trends.push(weight);

  return trends;
}

// ── Structured clinical findings ─────────────────────────────────────────────
// Produces importance-ranked ClinicalFinding[] the AI can use as a structured
// evidence base — preventing overlooked changes.

export function extractClinicalFindings(
  visits: VisitDTO[], // newest-first; V0=visits[0]
  medDeltas: MedicationDelta[],
  dxDeltas: DiagnosisDelta[],
  vitalTrends: VitalTrend[],
): ClinicalFinding[] {
  const findings: ClinicalFinding[] = [];

  // Build visit index map for reference labels
  const dateToRef = new Map<string, string>();
  visits.forEach((v, i) => dateToRef.set(v.date, visitRef(i)));

  // Medication changes
  for (const d of medDeltas) {
    const fromRef = d.previousVisitDate ? dateToRef.get(d.previousVisitDate) ?? d.previousVisitDate : "";
    const toRef = dateToRef.get(d.visitDate) ?? d.visitDate;
    findings.push({
      category: "medication_change",
      finding: `${d.drugName} — ${d.change === "added" ? "started" : "stopped"}`,
      previous: d.change === "added" ? "Not documented" : d.drugName,
      current: d.change === "added" ? d.drugName : "Not documented",
      change: d.change === "added" ? "STARTED" : "STOPPED",
      dateSource: d.previousVisitDate
        ? `${fromRef} ${d.previousVisitDate} → ${toRef} ${d.visitDate}`
        : toRef + " " + d.visitDate,
      importance: "high",
    });
  }

  // Diagnosis changes
  for (const d of dxDeltas) {
    const ref = dateToRef.get(d.visitDate) ?? d.visitDate;
    const lat = d.laterality ? ` (${d.laterality})` : "";
    findings.push({
      category: "diagnosis_change",
      finding: `${d.description}${lat}`,
      previous: d.change === "new" ? "Not previously documented" : "Provisional",
      current: d.change === "new" ? "Newly documented" : "Confirmed",
      change: d.change === "new" ? "NEW DIAGNOSIS" : "CONFIRMED",
      dateSource: `${ref} ${d.visitDate}`,
      importance: "high",
    });
  }

  // Vital trends
  for (const trend of vitalTrends) {
    if (!trend.delta || trend.direction === "stable" || trend.points.length < 2) continue;
    const first = trend.points[trend.points.length - 1];
    const latest = trend.points[0];
    findings.push({
      category: "vital_change",
      finding: trend.vital,
      previous: `${first.raw} (${first.visitRef} ${first.date})`,
      current: `${latest.raw} (${latest.visitRef} ${latest.date})`,
      change: `${trend.delta} ${trend.unit} — ${trend.direction?.toUpperCase()}`,
      dateSource: `${first.visitRef} ${first.date} → ${latest.visitRef} ${latest.date}`,
      importance: trend.direction === "increased" || trend.direction === "decreased" ? "medium" : "low",
    });
  }

  // Missing information detection
  if (visits.length > 0) {
    const current = visits[0];
    if (!current.vitals || Object.values(current.vitals).every((v) => !v)) {
      findings.push({
        category: "missing_information",
        finding: "No vitals documented in current visit",
        previous: "N/A",
        current: "Not documented",
        change: "MISSING",
        dateSource: `V0 ${current.date}`,
        importance: "low",
      });
    }
    if (current.diagnoses.length === 0) {
      findings.push({
        category: "missing_information",
        finding: "No diagnoses documented in current visit",
        previous: "N/A",
        current: "Not documented",
        change: "MISSING",
        dateSource: `V0 ${current.date}`,
        importance: "medium",
      });
    }
    if (!current.followUpDate) {
      findings.push({
        category: "followup_change",
        finding: "No follow-up date documented in current visit",
        previous: "N/A",
        current: "Not documented",
        change: "MISSING",
        dateSource: `V0 ${current.date}`,
        importance: "low",
      });
    }
  }

  // Sort: high → medium → low
  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.importance] - rank[b.importance]);

  return findings;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function extractClinicalEvidence(
  allVisits: VisitDTO[], // newest-first
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

// ── Context renderers ─────────────────────────────────────────────────────────

export function renderVisitReferenceGuide(visits: VisitDTO[]): string {
  if (visits.length === 0) return "";
  const lines = ["VISIT REFERENCE GUIDE (cite these when providing evidence):"];
  visits.forEach((v, i) => {
    lines.push(`  ${visitRef(i)}: ${v.date} | ${v.visitType} | ${v.status}`);
  });
  lines.push("When citing evidence, use: (Source: V0 2024-06-15) or similar.");
  return lines.join("\n");
}

export function renderVitalTrends(trends: VitalTrend[]): string {
  if (trends.length === 0) return "";
  const meaningful = trends.filter((t) => t.points.length >= 2 && t.direction !== "stable");
  if (meaningful.length === 0 && trends.every((t) => t.points.length < 2)) return "";

  const lines = ["VITAL SIGN TRENDS (computed from documented records):"];
  for (const t of trends) {
    if (t.points.length === 1) {
      lines.push(`  ${t.vital}: ${t.latest} (${t.unit}) — only one documented value`);
    } else {
      const hist = t.points
        .slice()
        .reverse()
        .map((p) => `${p.visitRef}=${p.raw}`)
        .join(" → ");
      lines.push(
        `  ${t.vital}: ${hist} | Delta: ${t.delta ?? "N/A"} ${t.unit} | Direction: ${t.direction?.toUpperCase() ?? "UNKNOWN"}`,
      );
    }
  }
  return lines.join("\n");
}

export function renderClinicalFindings(findings: ClinicalFinding[]): string {
  if (findings.length === 0) return "";
  const lines = ["STRUCTURED CLINICAL FINDINGS (pre-computed — cite these directly):"];
  let idx = 1;
  for (const f of findings) {
    lines.push(`  Finding ${idx++} [${f.importance.toUpperCase()}] [${f.category}]:`);
    lines.push(`    What: ${f.finding}`);
    lines.push(`    Previous: ${f.previous}`);
    lines.push(`    Current: ${f.current}`);
    lines.push(`    Change: ${f.change}`);
    lines.push(`    Source: ${f.dateSource}`);
  }
  return lines.join("\n");
}

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
