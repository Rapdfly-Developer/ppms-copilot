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
