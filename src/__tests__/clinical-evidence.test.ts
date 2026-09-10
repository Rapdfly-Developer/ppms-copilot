import { describe, it, expect } from "vitest";
import { extractClinicalEvidence, renderClinicalEvidence } from "@/context/evidence";
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

  it("maxTokens are increased vs original limits", async () => {
    const { CAPABILITY_CONFIG } = await import("@/capabilities");
    // Original: 500 for PATIENT_SNAPSHOT; upgraded to 700
    expect(CAPABILITY_CONFIG.PATIENT_SNAPSHOT.maxTokens).toBeGreaterThanOrEqual(700);
    // Original: 600 for IMPORTANT_CHANGES; upgraded to 1400
    expect(CAPABILITY_CONFIG.IMPORTANT_CHANGES.maxTokens).toBeGreaterThanOrEqual(1400);
    // Original: 1200 for NOTE_ASSISTANCE; upgraded to 1800
    expect(CAPABILITY_CONFIG.NOTE_ASSISTANCE.maxTokens).toBeGreaterThanOrEqual(1800);
  });
});
