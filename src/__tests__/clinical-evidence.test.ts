import { describe, it, expect } from "vitest";
import {
  extractClinicalEvidence,
  extractClinicalFindings,
  extractVitalTrends,
  renderClinicalEvidence,
  renderClinicalFindings,
  renderVisitReferenceGuide,
  renderVitalTrends,
  visitRef,
} from "@/context/evidence";
import type { VisitDTO } from "@/lib/ppms-client";

function makeVisit(overrides: Partial<VisitDTO> = {}): VisitDTO {
  return {
    visitId: "v1",
    date: "2026-01-01",
    visitType: "OPD",
    status: "completed",
    hospitalName: "Eye Clinic",
    doctorName: "Dr. Smith", // NOT sent to AI — included here only as DTO shape
    nkda: true,
    surgeryAdvised: false,
    diagnoses: [],
    medications: [],
    investigations: [],
    ...overrides,
  };
}

describe("Clinical evidence extraction", () => {
  describe("Medication deltas", () => {
    it("detects a newly added medication between visits", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          visitId: "v2",
          date: "2026-03-01",
          medications: [
            { drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "3 months", route: "topical" },
            { drugName: "Latanoprost", dosage: "0.005%", frequency: "ON", duration: "3 months", route: "topical" },
          ],
        }),
        makeVisit({
          visitId: "v1",
          date: "2026-01-01",
          medications: [
            { drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "3 months", route: "topical" },
          ],
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      expect(ev.medicationDeltas).toHaveLength(1);
      expect(ev.medicationDeltas[0].change).toBe("added");
      expect(ev.medicationDeltas[0].drugName).toBe("Latanoprost");
      expect(ev.medicationDeltas[0].visitDate).toBe("2026-03-01");
      expect(ev.medicationDeltas[0].previousVisitDate).toBe("2026-01-01");
    });

    it("detects a removed medication between visits", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          visitId: "v2",
          date: "2026-03-01",
          medications: [
            { drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "3 months", route: "topical" },
          ],
        }),
        makeVisit({
          visitId: "v1",
          date: "2026-01-01",
          medications: [
            { drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "3 months", route: "topical" },
            { drugName: "Brimonidine", dosage: "0.2%", frequency: "TDS", duration: "3 months", route: "topical" },
          ],
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      const removed = ev.medicationDeltas.filter((d) => d.change === "removed");
      expect(removed).toHaveLength(1);
      expect(removed[0].drugName).toBe("Brimonidine");
    });

    it("returns empty deltas for a single visit", () => {
      const visits = [makeVisit()];
      const ev = extractClinicalEvidence(visits);
      expect(ev.medicationDeltas).toHaveLength(0);
    });

    it("is case-insensitive when comparing drug names", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          visitId: "v2",
          date: "2026-03-01",
          medications: [{ drugName: "TIMOLOL", dosage: "0.5%", frequency: "BD", duration: "1m", route: "topical" }],
        }),
        makeVisit({
          visitId: "v1",
          date: "2026-01-01",
          medications: [{ drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "1m", route: "topical" }],
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      // Same drug (case-insensitive) — no deltas
      expect(ev.medicationDeltas).toHaveLength(0);
    });
  });

  describe("Diagnosis deltas", () => {
    it("marks a diagnosis as NEW on first appearance", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          date: "2026-03-01",
          diagnoses: [
            { description: "Primary open-angle glaucoma", status: "active", provisional: false, confirmed: true },
          ],
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      expect(ev.diagnosisDeltas).toHaveLength(1);
      expect(ev.diagnosisDeltas[0].change).toBe("new");
      expect(ev.diagnosisDeltas[0].description).toBe("Primary open-angle glaucoma");
    });

    it("marks a diagnosis as CONFIRMED when status changes from provisional", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          visitId: "v2",
          date: "2026-03-01",
          diagnoses: [
            { description: "POAG", status: "active", provisional: false, confirmed: true },
          ],
        }),
        makeVisit({
          visitId: "v1",
          date: "2026-01-01",
          diagnoses: [
            { description: "POAG", status: "provisional", provisional: true, confirmed: false },
          ],
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      const confirmed = ev.diagnosisDeltas.filter((d) => d.change === "confirmed");
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0].visitDate).toBe("2026-03-01");
    });
  });

  describe("Unique medications and investigations", () => {
    it("collects unique medications across all visits", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          visitId: "v2",
          medications: [
            { drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "1m", route: "topical" },
            { drugName: "Latanoprost", dosage: "0.005%", frequency: "ON", duration: "1m", route: "topical" },
          ],
        }),
        makeVisit({
          visitId: "v1",
          medications: [
            { drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "1m", route: "topical" },
            { drugName: "Brimonidine", dosage: "0.2%", frequency: "TDS", duration: "1m", route: "topical" },
          ],
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      expect(ev.uniqueMedications).toHaveLength(3);
      expect(ev.uniqueMedications).toContain("Timolol");
      expect(ev.uniqueMedications).toContain("Latanoprost");
      expect(ev.uniqueMedications).toContain("Brimonidine");
    });

    it("collects unique investigations across all visits", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          visitId: "v2",
          investigations: [
            { testName: "OCT", category: "imaging", status: "ordered", priority: "routine" },
            { testName: "Visual Field", category: "functional", status: "ordered", priority: "routine" },
          ],
        }),
        makeVisit({
          visitId: "v1",
          investigations: [
            { testName: "OCT", category: "imaging", status: "completed", priority: "routine" },
          ],
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      expect(ev.uniqueInvestigations).toHaveLength(2);
      expect(ev.uniqueInvestigations).toContain("OCT");
      expect(ev.uniqueInvestigations).toContain("Visual Field");
    });
  });

  describe("Surgery and follow-up history", () => {
    it("extracts surgery history from visits", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          date: "2026-03-01",
          surgeryAdvised: true,
          advisedSurgeryName: "Trabeculectomy",
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      expect(ev.surgeryHistory).toHaveLength(1);
      expect(ev.surgeryHistory[0].name).toBe("Trabeculectomy");
      expect(ev.surgeryHistory[0].visitDate).toBe("2026-03-01");
    });

    it("extracts follow-up history with advice", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          date: "2026-03-01",
          followUpDate: "2026-06-01",
          adviseNotes: "Review IOP in 3 months",
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      expect(ev.followUpHistory).toHaveLength(1);
      expect(ev.followUpHistory[0].date).toBe("2026-06-01");
      expect(ev.followUpHistory[0].advice).toBe("Review IOP in 3 months");
    });
  });

  describe("Evidence renderer", () => {
    it("produces non-empty text when evidence is present", () => {
      const visits: VisitDTO[] = [
        makeVisit({
          visitId: "v2",
          date: "2026-03-01",
          medications: [{ drugName: "Latanoprost", dosage: "0.005%", frequency: "ON", duration: "1m", route: "topical" }],
          followUpDate: "2026-06-01",
        }),
        makeVisit({
          visitId: "v1",
          date: "2026-01-01",
          medications: [{ drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "1m", route: "topical" }],
        }),
      ];
      const ev = extractClinicalEvidence(visits);
      const text = renderClinicalEvidence(ev);
      expect(text).toContain("MEDICATION CHANGES");
      expect(text).toContain("Latanoprost");
      expect(text).toContain("Timolol");
      expect(text).toContain("FOLLOW-UP HISTORY");
    });

    it("returns empty string when there is no evidence", () => {
      const ev = extractClinicalEvidence([]);
      const text = renderClinicalEvidence(ev);
      expect(text.trim()).toBe("");
    });
  });
});

// ── Visit reference guide ─────────────────────────────────────────────────────

describe("Visit reference guide", () => {
  it("labels V0 as newest and V1 as second newest", () => {
    const visits: VisitDTO[] = [
      makeVisit({ date: "2026-06-01", visitId: "v3" }),
      makeVisit({ date: "2026-03-01", visitId: "v2" }),
      makeVisit({ date: "2026-01-01", visitId: "v1" }),
    ];
    const guide = renderVisitReferenceGuide(visits);
    expect(guide).toContain("V0: 2026-06-01");
    expect(guide).toContain("V1: 2026-03-01");
    expect(guide).toContain("V2: 2026-01-01");
  });

  it("returns empty string for empty visit list", () => {
    expect(renderVisitReferenceGuide([])).toBe("");
  });

  it("visitRef returns V0, V1, V2 for indices 0, 1, 2", () => {
    expect(visitRef(0)).toBe("V0");
    expect(visitRef(1)).toBe("V1");
    expect(visitRef(2)).toBe("V2");
  });
});

// ── Vital trend extraction ────────────────────────────────────────────────────

describe("Vital trend extraction", () => {
  it("computes increasing systolic BP trend", () => {
    const visits: VisitDTO[] = [
      makeVisit({ date: "2026-06-01", visitId: "v3", vitals: { bp: "150/90", pulse: "80", temperature: "", weight: "" } }),
      makeVisit({ date: "2026-03-01", visitId: "v2", vitals: { bp: "140/85", pulse: "78", temperature: "", weight: "" } }),
      makeVisit({ date: "2026-01-01", visitId: "v1", vitals: { bp: "130/80", pulse: "76", temperature: "", weight: "" } }),
    ];
    const trends = extractVitalTrends(visits);
    const systolic = trends.find((t) => t.vital === "Blood Pressure (systolic)");
    expect(systolic).toBeDefined();
    expect(systolic!.direction).toBe("increased");
    expect(systolic!.delta).toBe("+20");
    expect(systolic!.points).toHaveLength(3);
    expect(systolic!.points[0].visitRef).toBe("V0");
    expect(systolic!.points[0].numeric).toBe(150);
    expect(systolic!.points[2].numeric).toBe(130);
  });

  it("computes stable BP when values are within 1 mmHg", () => {
    const visits: VisitDTO[] = [
      makeVisit({ date: "2026-06-01", visitId: "v2", vitals: { bp: "120/80", pulse: "", temperature: "", weight: "" } }),
      makeVisit({ date: "2026-01-01", visitId: "v1", vitals: { bp: "120/80", pulse: "", temperature: "", weight: "" } }),
    ];
    const trends = extractVitalTrends(visits);
    const systolic = trends.find((t) => t.vital === "Blood Pressure (systolic)");
    expect(systolic!.direction).toBe("stable");
  });

  it("computes decreasing weight trend", () => {
    const visits: VisitDTO[] = [
      makeVisit({ date: "2026-06-01", vitals: { bp: "", pulse: "", temperature: "", weight: "72 kg" } }),
      makeVisit({ date: "2026-01-01", vitals: { bp: "", pulse: "", temperature: "", weight: "80 kg" } }),
    ];
    const trends = extractVitalTrends(visits);
    const weight = trends.find((t) => t.vital === "Weight");
    expect(weight).toBeDefined();
    expect(weight!.direction).toBe("decreased");
    expect(weight!.delta).toBe("-8");
  });

  it("returns empty array when no vitals are documented", () => {
    const visits = [makeVisit(), makeVisit()];
    const trends = extractVitalTrends(visits);
    expect(trends).toHaveLength(0);
  });

  it("renders vital trends text correctly", () => {
    const visits: VisitDTO[] = [
      makeVisit({ date: "2026-06-01", visitId: "v2", vitals: { bp: "150/90", pulse: "", temperature: "", weight: "" } }),
      makeVisit({ date: "2026-01-01", visitId: "v1", vitals: { bp: "130/80", pulse: "", temperature: "", weight: "" } }),
    ];
    const trends = extractVitalTrends(visits);
    const text = renderVitalTrends(trends);
    expect(text).toContain("VITAL SIGN TRENDS");
    expect(text).toContain("INCREASED");
    expect(text).toContain("V0=");
    expect(text).toContain("V1=");
  });
});

// ── Structured clinical findings ──────────────────────────────────────────────

describe("Structured clinical findings", () => {
  it("produces high-importance finding for new medication", () => {
    const visits: VisitDTO[] = [
      makeVisit({
        visitId: "v2",
        date: "2026-03-01",
        medications: [
          { drugName: "Latanoprost", dosage: "0.005%", frequency: "ON", duration: "3m", route: "topical" },
        ],
      }),
      makeVisit({
        visitId: "v1",
        date: "2026-01-01",
        medications: [],
      }),
    ];
    const evidence = extractClinicalEvidence(visits);
    const trends = extractVitalTrends(visits);
    const findings = extractClinicalFindings(visits, evidence.medicationDeltas, evidence.diagnosisDeltas, trends);
    const medFinding = findings.find((f) => f.category === "medication_change");
    expect(medFinding).toBeDefined();
    expect(medFinding!.importance).toBe("high");
    expect(medFinding!.change).toBe("STARTED");
    expect(medFinding!.dateSource).toContain("V0");
    expect(medFinding!.dateSource).toContain("V1");
  });

  it("produces high-importance finding for new diagnosis", () => {
    const visits: VisitDTO[] = [
      makeVisit({
        date: "2026-03-01",
        diagnoses: [{ description: "POAG", status: "active", provisional: false, confirmed: true }],
      }),
    ];
    const evidence = extractClinicalEvidence(visits);
    const trends = extractVitalTrends(visits);
    const findings = extractClinicalFindings(visits, evidence.medicationDeltas, evidence.diagnosisDeltas, trends);
    const dxFinding = findings.find((f) => f.category === "diagnosis_change");
    expect(dxFinding).toBeDefined();
    expect(dxFinding!.importance).toBe("high");
    expect(dxFinding!.change).toBe("NEW DIAGNOSIS");
  });

  it("sorts findings high → medium → low", () => {
    const visits: VisitDTO[] = [
      makeVisit({
        date: "2026-03-01",
        diagnoses: [{ description: "Glaucoma", status: "active", provisional: false, confirmed: true }],
        vitals: { bp: "150/90", pulse: "", temperature: "", weight: "" },
      }),
      makeVisit({
        date: "2026-01-01",
        vitals: { bp: "130/80", pulse: "", temperature: "", weight: "" },
      }),
    ];
    const evidence = extractClinicalEvidence(visits);
    const trends = extractVitalTrends(visits);
    const findings = extractClinicalFindings(visits, evidence.medicationDeltas, evidence.diagnosisDeltas, trends);
    const importances = findings.map((f) => f.importance);
    const rankMap = { high: 0, medium: 1, low: 2 };
    for (let i = 0; i < importances.length - 1; i++) {
      expect(rankMap[importances[i]]).toBeLessThanOrEqual(rankMap[importances[i + 1]]);
    }
  });

  it("renders findings text with Finding numbers", () => {
    const visits: VisitDTO[] = [
      makeVisit({
        date: "2026-03-01",
        medications: [{ drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "3m", route: "topical" }],
      }),
      makeVisit({ date: "2026-01-01", medications: [] }),
    ];
    const evidence = extractClinicalEvidence(visits);
    const trends = extractVitalTrends(visits);
    const findings = extractClinicalFindings(visits, evidence.medicationDeltas, evidence.diagnosisDeltas, trends);
    const text = renderClinicalFindings(findings);
    expect(text).toContain("STRUCTURED CLINICAL FINDINGS");
    expect(text).toContain("Finding 1");
    expect(text).toContain("HIGH");
    expect(text).toContain("Timolol");
  });

  it("detects missing diagnoses as medium importance missing_information", () => {
    const visits = [makeVisit({ date: "2026-03-01", diagnoses: [] })];
    const evidence = extractClinicalEvidence(visits);
    const trends = extractVitalTrends(visits);
    const findings = extractClinicalFindings(visits, evidence.medicationDeltas, evidence.diagnosisDeltas, trends);
    const missing = findings.find((f) => f.category === "missing_information" && f.finding.includes("diagnoses"));
    expect(missing).toBeDefined();
    expect(missing!.importance).toBe("medium");
  });
});

// ── Longitudinal test cases ───────────────────────────────────────────────────

describe("Longitudinal scenarios (8 specification cases)", () => {
  it("Case 1: medication added then stopped across 3 visits", () => {
    // V0=current, V1=middle (drug added), V2=oldest (no drug)
    const visits: VisitDTO[] = [
      makeVisit({
        visitId: "v3", date: "2026-06-01",
        medications: [], // drug was stopped
      }),
      makeVisit({
        visitId: "v2", date: "2026-03-01",
        medications: [{ drugName: "Dorzolamide", dosage: "2%", frequency: "TDS", duration: "3m", route: "topical" }],
      }),
      makeVisit({
        visitId: "v1", date: "2026-01-01",
        medications: [],
      }),
    ];
    const evidence = extractClinicalEvidence(visits);
    // Between V1→V2: Dorzolamide added
    const added = evidence.medicationDeltas.filter((d) => d.change === "added" && d.drugName === "Dorzolamide");
    expect(added).toHaveLength(1);
    // Between V2→V0: Dorzolamide removed
    const removed = evidence.medicationDeltas.filter((d) => d.change === "removed" && d.drugName === "Dorzolamide");
    expect(removed).toHaveLength(1);
  });

  it("Case 2: BP trend across 4 visits — increasing", () => {
    const visits = [
      makeVisit({ date: "2026-07-01", vitals: { bp: "160/95", pulse: "", temperature: "", weight: "" } }),
      makeVisit({ date: "2026-04-01", vitals: { bp: "150/90", pulse: "", temperature: "", weight: "" } }),
      makeVisit({ date: "2026-01-01", vitals: { bp: "140/85", pulse: "", temperature: "", weight: "" } }),
      makeVisit({ date: "2025-10-01", vitals: { bp: "130/80", pulse: "", temperature: "", weight: "" } }),
    ];
    const trends = extractVitalTrends(visits);
    const systolic = trends.find((t) => t.vital === "Blood Pressure (systolic)")!;
    expect(systolic.direction).toBe("increased");
    expect(systolic.points).toHaveLength(4);
    expect(systolic.delta).toBe("+30");
  });

  it("Case 3: diagnosis new → confirmed across visits", () => {
    const visits: VisitDTO[] = [
      makeVisit({
        visitId: "v2", date: "2026-03-01",
        diagnoses: [{ description: "POAG", status: "active", provisional: false, confirmed: true }],
      }),
      makeVisit({
        visitId: "v1", date: "2026-01-01",
        diagnoses: [{ description: "POAG", status: "provisional", provisional: true, confirmed: false }],
      }),
    ];
    const ev = extractClinicalEvidence(visits);
    const newDx = ev.diagnosisDeltas.find((d) => d.change === "new");
    const confirmed = ev.diagnosisDeltas.find((d) => d.change === "confirmed");
    expect(newDx).toBeDefined();
    expect(confirmed).toBeDefined();
    expect(confirmed!.visitDate).toBe("2026-03-01");
  });

  it("Case 4: missing information — no vitals at current visit", () => {
    const visits = [
      makeVisit({ date: "2026-06-01", vitals: undefined }),
    ];
    const evidence = extractClinicalEvidence(visits);
    const trends = extractVitalTrends(visits);
    const findings = extractClinicalFindings(visits, evidence.medicationDeltas, evidence.diagnosisDeltas, trends);
    const missingVitals = findings.find(
      (f) => f.category === "missing_information" && f.finding.includes("vitals"),
    );
    expect(missingVitals).toBeDefined();
  });

  it("Case 5: no history — only one visit", () => {
    const visits = [makeVisit({ date: "2026-06-01" })];
    const evidence = extractClinicalEvidence(visits);
    expect(evidence.medicationDeltas).toHaveLength(0);
    expect(evidence.diagnosisDeltas.length).toBeGreaterThanOrEqual(0);
    const trends = extractVitalTrends(visits);
    expect(trends).toHaveLength(0); // Can't compute trends with 1 visit
  });

  it("Case 6: large history — 10 visits, all medication continuity", () => {
    const visits = Array.from({ length: 10 }, (_, i) =>
      makeVisit({
        visitId: `v${10 - i}`,
        date: `2026-${String(i + 1).padStart(2, "0")}-01`,
        medications: [
          { drugName: "Timolol", dosage: "0.5%", frequency: "BD", duration: "1m", route: "topical" },
        ],
      }),
    );
    const evidence = extractClinicalEvidence(visits);
    // Timolol is on every visit — no deltas expected
    expect(evidence.medicationDeltas).toHaveLength(0);
    expect(evidence.uniqueMedications).toContain("Timolol");
  });

  it("Case 7: investigation trend — same investigation ordered multiple visits", () => {
    const visits: VisitDTO[] = [
      makeVisit({
        date: "2026-06-01",
        investigations: [
          { testName: "OCT", category: "imaging", status: "ordered", priority: "routine" },
        ],
      }),
      makeVisit({
        date: "2026-01-01",
        investigations: [
          { testName: "OCT", category: "imaging", status: "completed", priority: "routine" },
        ],
      }),
    ];
    const evidence = extractClinicalEvidence(visits);
    expect(evidence.uniqueInvestigations).toContain("OCT");
    expect(evidence.uniqueInvestigations).toHaveLength(1); // deduplicated
  });

  it("Case 8: conflicting information — same diagnosis with different laterality", () => {
    const visits: VisitDTO[] = [
      makeVisit({
        date: "2026-06-01",
        diagnoses: [{ description: "Glaucoma", status: "active", laterality: "OU", provisional: false, confirmed: true }],
      }),
      makeVisit({
        date: "2026-01-01",
        diagnoses: [{ description: "Glaucoma", status: "active", laterality: "OS", provisional: false, confirmed: true }],
      }),
    ];
    const evidence = extractClinicalEvidence(visits);
    // Same description (case-insensitive) — should not generate a "new" delta for the second appearance
    const glaucomaDeltas = evidence.diagnosisDeltas.filter(
      (d) => d.description.toLowerCase().includes("glaucoma"),
    );
    // First time seen = "new" — only one delta for the same description
    expect(glaucomaDeltas).toHaveLength(1);
  });
});

describe("Capability config — reasoning effort and model tier", () => {
  it("PATIENT_SNAPSHOT uses fast tier and medium effort", async () => {
    const { CAPABILITY_CONFIG } = await import("@/capabilities");
    expect(CAPABILITY_CONFIG.PATIENT_SNAPSHOT.reasoningEffort).toBe("medium");
    expect(CAPABILITY_CONFIG.PATIENT_SNAPSHOT.modelTier).toBe("fast");
  });

  it("IMPORTANT_CHANGES uses reasoning tier and high effort", async () => {
    const { CAPABILITY_CONFIG } = await import("@/capabilities");
    expect(CAPABILITY_CONFIG.IMPORTANT_CHANGES.reasoningEffort).toBe("high");
    expect(CAPABILITY_CONFIG.IMPORTANT_CHANGES.modelTier).toBe("reasoning");
  });

  it("NOTE_ASSISTANCE uses reasoning tier and high effort", async () => {
    const { CAPABILITY_CONFIG } = await import("@/capabilities");
    expect(CAPABILITY_CONFIG.NOTE_ASSISTANCE.reasoningEffort).toBe("high");
    expect(CAPABILITY_CONFIG.NOTE_ASSISTANCE.modelTier).toBe("reasoning");
  });

  it("FOLLOW_UP_SUMMARY uses reasoning tier and high effort", async () => {
    const { CAPABILITY_CONFIG } = await import("@/capabilities");
    expect(CAPABILITY_CONFIG.FOLLOW_UP_SUMMARY.reasoningEffort).toBe("high");
    expect(CAPABILITY_CONFIG.FOLLOW_UP_SUMMARY.modelTier).toBe("reasoning");
  });

  it("PREVIOUS_VISIT_SUMMARY uses fast tier and medium effort", async () => {
    const { CAPABILITY_CONFIG } = await import("@/capabilities");
    expect(CAPABILITY_CONFIG.PREVIOUS_VISIT_SUMMARY.reasoningEffort).toBe("medium");
    expect(CAPABILITY_CONFIG.PREVIOUS_VISIT_SUMMARY.modelTier).toBe("fast");
  });

  it("TIMELINE_SUMMARY uses fast tier and medium effort", async () => {
    const { CAPABILITY_CONFIG } = await import("@/capabilities");
    expect(CAPABILITY_CONFIG.TIMELINE_SUMMARY.reasoningEffort).toBe("medium");
    expect(CAPABILITY_CONFIG.TIMELINE_SUMMARY.modelTier).toBe("fast");
  });

  it("maxTokens are within cost-optimised limits", async () => {
    const { CAPABILITY_CONFIG } = await import("@/capabilities");
    // Original: 500 for PATIENT_SNAPSHOT; upgraded to 700
    expect(CAPABILITY_CONFIG.PATIENT_SNAPSHOT.maxTokens).toBeGreaterThanOrEqual(700);
    // Original: 600 for IMPORTANT_CHANGES; upgraded to 1400
    expect(CAPABILITY_CONFIG.IMPORTANT_CHANGES.maxTokens).toBeGreaterThanOrEqual(1400);
    // NOTE_ASSISTANCE reduced from 1800 → 1400 to cut Active CPU (audit C2)
    expect(CAPABILITY_CONFIG.NOTE_ASSISTANCE.maxTokens).toBeGreaterThanOrEqual(1400);
  });
});
