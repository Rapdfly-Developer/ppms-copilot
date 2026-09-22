import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPatientContext } from "@/context/builder";
import * as ppmsClient from "@/lib/ppms-client";
import {
  FIXTURE_PATIENT,
  FIXTURE_VISIT_CURRENT,
  FIXTURE_VISIT_PREVIOUS,
  FIXTURE_APPOINTMENTS,
  FIXTURE_TIMELINE,
  FIXTURE_TOKEN,
} from "./fixtures/patient";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Clinical context builder", () => {
  describe("PATIENT_SNAPSHOT — fetches demographics + current visit only", () => {
    it("calls getPatient and getVisit; does NOT call getVisits/getTimeline/getAppointments", async () => {
      const getPatientSpy = vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      const getVisitSpy = vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      const getVisitsSpy = vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      const getAppointmentsSpy = vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      const getTimelineSpy = vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PATIENT_SNAPSHOT",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(getPatientSpy).toHaveBeenCalledOnce();
      expect(getVisitSpy).toHaveBeenCalledOnce();
      expect(getVisitsSpy).not.toHaveBeenCalled();
      expect(getAppointmentsSpy).not.toHaveBeenCalled();
      expect(getTimelineSpy).not.toHaveBeenCalled();
    });
  });

  describe("TIMELINE_SUMMARY — fetches timeline + appointments; no visit history", () => {
    it("calls getTimeline and getAppointments; does NOT call getVisits or getVisit", async () => {
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      const getVisitSpy = vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      const getVisitsSpy = vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      const getAppointmentsSpy = vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue(FIXTURE_APPOINTMENTS);
      const getTimelineSpy = vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue(FIXTURE_TIMELINE);

      await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "TIMELINE_SUMMARY",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(getVisitSpy).not.toHaveBeenCalled();
      expect(getVisitsSpy).not.toHaveBeenCalled();
      expect(getAppointmentsSpy).toHaveBeenCalledOnce();
      expect(getTimelineSpy).toHaveBeenCalledOnce();
    });
  });

  describe("Context text content", () => {
    it("includes clinical category in demographics section", async () => {
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PATIENT_SNAPSHOT",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).toContain("Glaucoma");
      expect(ctx.text).toContain("52-year-old male");
      expect(ctx.text).toContain("Blurred vision right eye");
    });

    it("includes visit diagnoses in context", async () => {
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PATIENT_SNAPSHOT",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).toContain("Primary open-angle glaucoma");
      expect(ctx.text).toContain("H40.11");
      expect(ctx.text).toContain("confirmed");
    });

    it("excludes current visit from visit history section", async () => {
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([
        FIXTURE_VISIT_CURRENT, // same visitId — should be filtered out from history
        FIXTURE_VISIT_PREVIOUS,
      ]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "HISTORY_SUMMARY",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      // Current visit should not appear as "Visit 1" in history — it's filtered
      // Previous visit date should appear
      expect(ctx.text).toContain("2023-12-10");
      // Current visit date should not appear twice (it's not in history section)
      const occurrences = (ctx.text.match(/visit-current-001/g) ?? []).length;
      expect(occurrences).toBe(0); // visitId is not rendered in text
    });

    it("includes reportedMedications in the rendered visit text", async () => {
      // reportedMedications is fetched on VisitDTO but was never wired into
      // renderVisit() — a real gap (confirmed by grep against ppms-client.ts)
      // fixed alongside the EXAM_GUIDANCE capability that needs it.
      const visitWithReportedMedications = {
        ...FIXTURE_VISIT_CURRENT,
        reportedMedications: "Patient reports taking over-the-counter artificial tears twice daily",
      };
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(visitWithReportedMedications);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PATIENT_SNAPSHOT",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).toContain("Reported medications: Patient reports taking over-the-counter artificial tears twice daily");
    });

    it("includes refraction and visual acuity in the rendered visit text", async () => {
      const visitWithRefractiveData = {
        ...FIXTURE_VISIT_CURRENT,
        refraction: {
          re: { sph: "-3.00", cyl: "-0.50", axis: "180", va: "6/6", method: "Subjective" },
          le: undefined,
        },
        visualAcuity: {
          testMethod: "Snellen",
          re: { unaided: "6/9", bestCorrected: "6/6" },
          le: undefined,
        },
      };
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(visitWithRefractiveData);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "REFRACTIVE_GUIDANCE",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).toContain("Refraction: RE: Sph -3.00, Cyl -0.50, Axis 180, VA 6/6, Method Subjective");
      expect(ctx.text).toContain("Visual Acuity: Snellen — RE: Unaided 6/9, Best corrected 6/6");
    });

    it("includes SUB-TAB DOCUMENTATION STATUS and surfaces DocumentedFlags on PatientContext.documented", async () => {
      const documented = {
        visualAcuity: true,
        refraction: true,
        anteriorSegment: false,
        posteriorSegment: false,
      };
      const visitWithDocumentedFlags = { ...FIXTURE_VISIT_CURRENT, documented };
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(visitWithDocumentedFlags);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "REFRACTIVE_GUIDANCE",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).toContain("=== SUB-TAB DOCUMENTATION STATUS (computed — do not recalculate) ===");
      expect(ctx.text).toContain("Visual Acuity: Documented");
      expect(ctx.text).toContain("Refraction: Documented");
      expect(ctx.text).toContain("Anterior Segment: Not documented");
      expect(ctx.text).toContain("Posterior Segment: Not documented");
      // The validator must check the model's claims against THIS original
      // object, not against the rendered text above — confirm it's threaded
      // through PatientContext, not just flattened into prose.
      expect(ctx.documented).toEqual(documented);
    });

    it("omits SUB-TAB DOCUMENTATION STATUS and leaves PatientContext.documented undefined when absent", async () => {
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT); // no `documented` field
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "REFRACTIVE_GUIDANCE",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).not.toContain("SUB-TAB DOCUMENTATION STATUS");
      expect(ctx.documented).toBeUndefined();
    });
  });

  describe("PLAN_GUIDANCE data: referral/dispense rendering and govt scheme matching", () => {
    it("includes referral and dispense summary in the rendered visit text", async () => {
      const visitWithDisposition = {
        ...FIXTURE_VISIT_CURRENT,
        referralEnabled: true,
        referralNote: "Referred to retina specialist for further evaluation",
        dispenseSummary: "Dispensed 1 month supply of Timolol 0.5% eye drops",
      };
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(visitWithDisposition);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PLAN_GUIDANCE",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).toContain("Referral: documented — Referred to retina specialist for further evaluation");
      expect(ctx.text).toContain("Dispense summary: Dispensed 1 month supply of Timolol 0.5% eye drops");
    });

    it("omits the Referral line entirely when referralEnabled is false, even with a note present", async () => {
      const visitWithDisabledReferral = {
        ...FIXTURE_VISIT_CURRENT,
        referralEnabled: false,
        referralNote: "Stale note from a previous toggle",
      };
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(visitWithDisabledReferral);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PLAN_GUIDANCE",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).not.toContain("Referral:");
    });

    it("includes APPLICABLE GOVT SCHEME and surfaces matchedGovtScheme on PatientContext when the diagnosis matches", async () => {
      const visitWithCataract = {
        ...FIXTURE_VISIT_CURRENT,
        diagnoses: [
          { description: "Age-related cataract", icd10Code: "H25.9", status: "ACTIVE", provisional: false, confirmed: true },
        ],
      };
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(visitWithCataract);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PLAN_GUIDANCE",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).toContain("=== APPLICABLE GOVT SCHEME (computed — cite verbatim only) ===");
      expect(ctx.matchedGovtScheme).not.toBeUndefined();
      expect(ctx.matchedGovtScheme?.id).toBe("ab-pmjay");
    });

    it("omits APPLICABLE GOVT SCHEME and leaves matchedGovtScheme undefined when no diagnosis matches", async () => {
      // FIXTURE_VISIT_CURRENT's glaucoma diagnosis (H40.11) matches no entry.
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PLAN_GUIDANCE",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.text).not.toContain("APPLICABLE GOVT SCHEME");
      expect(ctx.matchedGovtScheme).toBeUndefined();
    });
  });

  describe("Context stats", () => {
    it("reports correct visit count", async () => {
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([FIXTURE_VISIT_PREVIOUS]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "NOTE_ASSISTANCE",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      // current visit + 1 previous visit
      expect(ctx.stats.visitsIncluded).toBe(2);
      expect(ctx.stats.estimatedTokens).toBeGreaterThan(0);
    });

    it("preserves visitId in context object (for audit) but not in text", async () => {
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const ctx = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PATIENT_SNAPSHOT",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(ctx.visitId).toBe("visit-current-001");
      expect(ctx.text).not.toContain("visit-current-001");
    });
  });

  describe("Error propagation", () => {
    it("propagates CopilotError when PPMS returns 401", async () => {
      const { CopilotError } = await import("@/lib/errors");
      vi.spyOn(ppmsClient, "getPatient").mockRejectedValue(
        new CopilotError("TOKEN_EXPIRED", "Token expired", 401),
      );
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      await expect(
        buildPatientContext({
          token: FIXTURE_TOKEN,
          capability: "PATIENT_SNAPSHOT",
          patientRef: FIXTURE_PATIENT.udid,
          visitId: FIXTURE_VISIT_CURRENT.visitId,
        }),
      ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    });
  });
});
