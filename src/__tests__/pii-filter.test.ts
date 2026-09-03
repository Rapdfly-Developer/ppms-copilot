import { describe, it, expect } from "vitest";
import { toSafePatientSummary, assertNoPii, estimateTokens } from "@/context/pii";
import { buildPatientContext } from "@/context/builder";
import {
  FIXTURE_PATIENT,
  FIXTURE_VISIT_CURRENT,
  FIXTURE_VISIT_PREVIOUS,
  FIXTURE_APPOINTMENTS,
  FIXTURE_TIMELINE,
  FIXTURE_TOKEN,
} from "./fixtures/patient";
import * as ppmsClient from "@/lib/ppms-client";
import { vi } from "vitest";

describe("PII filtering", () => {
  describe("toSafePatientSummary", () => {
    it("produces ageAndSex without name", () => {
      const safe = toSafePatientSummary(FIXTURE_PATIENT);
      expect(safe.ageAndSex).toBe("52-year-old male");
      expect(safe.ageAndSex).not.toContain(FIXTURE_PATIENT.name);
    });

    it("does not include patient name field", () => {
      const safe = toSafePatientSummary(FIXTURE_PATIENT);
      expect(Object.keys(safe)).not.toContain("name");
      expect(JSON.stringify(safe)).not.toContain(FIXTURE_PATIENT.name);
    });

    it("does not include UDID", () => {
      const safe = toSafePatientSummary(FIXTURE_PATIENT);
      expect(JSON.stringify(safe)).not.toContain(FIXTURE_PATIENT.udid);
    });

    it("does not include patientId", () => {
      const safe = toSafePatientSummary(FIXTURE_PATIENT);
      expect(JSON.stringify(safe)).not.toContain(FIXTURE_PATIENT.patientId);
    });

    it("includes only the registration year, not the full date", () => {
      const safe = toSafePatientSummary(FIXTURE_PATIENT);
      expect(safe.registeredYear).toBe("2022");
      expect(safe.registeredYear).not.toContain("03-10");
    });

    it("lowercases sex for natural language", () => {
      const safe = toSafePatientSummary(FIXTURE_PATIENT);
      expect(safe.ageAndSex).toContain("male");
      expect(safe.ageAndSex).not.toContain("Male");
    });
  });

  describe("assertNoPii", () => {
    it("passes when text does not contain known PII", () => {
      expect(() =>
        assertNoPii("Patient: 52-year-old male", FIXTURE_PATIENT.name, FIXTURE_PATIENT.udid),
      ).not.toThrow();
    });

    it("throws when text contains patient name", () => {
      expect(() =>
        assertNoPii(
          `Patient name: ${FIXTURE_PATIENT.name}`,
          FIXTURE_PATIENT.name,
          FIXTURE_PATIENT.udid,
        ),
      ).toThrow("PII leak");
    });

    it("throws when text contains UDID", () => {
      expect(() =>
        assertNoPii(
          `Reference: ${FIXTURE_PATIENT.udid}`,
          FIXTURE_PATIENT.name,
          FIXTURE_PATIENT.udid,
        ),
      ).toThrow("PII leak");
    });
  });

  describe("Context builder PII exclusion", () => {
    it("context text does not contain patient name or UDID", async () => {
      // Mock all PPMS client functions
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([FIXTURE_VISIT_PREVIOUS]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue(FIXTURE_APPOINTMENTS);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue(FIXTURE_TIMELINE);

      const context = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PATIENT_SNAPSHOT",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      // Primary assertion: context text must not contain identity fields
      expect(context.text).not.toContain(FIXTURE_PATIENT.name);
      expect(context.text).not.toContain(FIXTURE_PATIENT.udid);
      expect(context.text).not.toContain(FIXTURE_PATIENT.patientId);

      // Using assertNoPii as a double-check
      expect(() =>
        assertNoPii(context.text, FIXTURE_PATIENT.name, FIXTURE_PATIENT.udid),
      ).not.toThrow();

      vi.restoreAllMocks();
    });

    it("context text does not contain doctor name", async () => {
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue([]);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue([]);

      const context = await buildPatientContext({
        token: FIXTURE_TOKEN,
        capability: "PATIENT_SNAPSHOT",
        patientRef: FIXTURE_PATIENT.udid,
        visitId: FIXTURE_VISIT_CURRENT.visitId,
      });

      expect(context.text).not.toContain(FIXTURE_VISIT_CURRENT.doctorName);

      vi.restoreAllMocks();
    });
  });

  describe("estimateTokens", () => {
    it("estimates roughly 1 token per 4 characters", () => {
      expect(estimateTokens("abcd")).toBe(1);
      expect(estimateTokens("a".repeat(400))).toBe(100);
    });

    it("rounds up for partial tokens", () => {
      expect(estimateTokens("abc")).toBe(1);
      expect(estimateTokens("abcde")).toBe(2);
    });
  });
});
