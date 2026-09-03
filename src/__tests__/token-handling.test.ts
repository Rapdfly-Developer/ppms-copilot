import { describe, it, expect } from "vitest";
import { parseRequest } from "@/schemas/request";
import { makeFixtureToken, FIXTURE_TOKEN, FIXTURE_EXPIRED_TOKEN } from "./fixtures/patient";

describe("Token handling", () => {
  describe("parseRequest — token extraction", () => {
    it("rejects requests with no Authorization header", () => {
      const result = parseRequest({ capability: "PATIENT_SNAPSHOT" }, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("TOKEN_MISSING");
    });

    it("rejects requests with Authorization header that is not Bearer", () => {
      const result = parseRequest(
        { capability: "PATIENT_SNAPSHOT" },
        "Basic dXNlcjpwYXNz",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("TOKEN_MISSING");
    });

    it("rejects an empty Bearer token", () => {
      const result = parseRequest({ capability: "PATIENT_SNAPSHOT" }, "Bearer  ");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("TOKEN_MISSING");
    });

    it("rejects a malformed token (wrong segment count)", () => {
      const result = parseRequest(
        { capability: "PATIENT_SNAPSHOT" },
        "Bearer notavalidtoken",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("TOKEN_INVALID");
    });

    it("rejects an expired token", () => {
      const result = parseRequest(
        { capability: "PATIENT_SNAPSHOT" },
        `Bearer ${FIXTURE_EXPIRED_TOKEN}`,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("TOKEN_INVALID");
    });

    it("accepts a valid token and extracts patientRef and visitId from the token payload", () => {
      const result = parseRequest(
        { capability: "PATIENT_SNAPSHOT" },
        `Bearer ${FIXTURE_TOKEN}`,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.patientRef).toBe("TEST-UDID-ALPHA-001");
        expect(result.data.visitId).toBe("visit-current-001");
        // The token itself is forwarded unchanged
        expect(result.data.token).toBe(FIXTURE_TOKEN);
      }
    });
  });

  describe("parseRequest — patientRef MUST come from token, not body", () => {
    it("ignores patientRef supplied in the request body", () => {
      const result = parseRequest(
        {
          capability: "PATIENT_SNAPSHOT",
          // Attempt to override patientRef from body — must be ignored
          patientRef: "ATTACKER-PATIENT-REF",
        },
        `Bearer ${FIXTURE_TOKEN}`,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Must come from the token, not the body
        expect(result.data.patientRef).toBe("TEST-UDID-ALPHA-001");
        expect(result.data.patientRef).not.toBe("ATTACKER-PATIENT-REF");
      }
    });

    it("ignores visitId supplied in the request body", () => {
      const result = parseRequest(
        {
          capability: "PATIENT_SNAPSHOT",
          visitId: "ATTACKER-VISIT-ID",
        },
        `Bearer ${FIXTURE_TOKEN}`,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.visitId).toBe("visit-current-001");
        expect(result.data.visitId).not.toBe("ATTACKER-VISIT-ID");
      }
    });

    it("ignores doctorId supplied in the request body", () => {
      // doctorId is not even a field in CopilotRequest — it stays in the token only
      const result = parseRequest(
        {
          capability: "PATIENT_SNAPSHOT",
          doctorId: "ATTACKER-DOCTOR-ID",
        },
        `Bearer ${FIXTURE_TOKEN}`,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.data as Record<string, unknown>).doctorId).toBeUndefined();
      }
    });
  });

  describe("parseRequest — capability validation", () => {
    it("rejects an invalid capability string", () => {
      const result = parseRequest(
        { capability: "MAKE_A_DIAGNOSIS" },
        `Bearer ${FIXTURE_TOKEN}`,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_CAPABILITY");
    });

    it("accepts all known valid capabilities", () => {
      const validCaps = [
        "PATIENT_SNAPSHOT",
        "PREVIOUS_VISIT_SUMMARY",
        "HISTORY_SUMMARY",
        "TIMELINE_SUMMARY",
        "IMPORTANT_CHANGES",
        "NOTE_ASSISTANCE",
        "FOLLOW_UP_SUMMARY",
        "QUESTION",
      ];
      for (const cap of validCaps) {
        const result = parseRequest(
          { capability: cap },
          `Bearer ${FIXTURE_TOKEN}`,
        );
        expect(result.ok).toBe(true);
      }
    });
  });

  describe("parseRequest — question field", () => {
    it("accepts a valid question string", () => {
      const result = parseRequest(
        { capability: "QUESTION", question: "What medications is the patient on?" },
        `Bearer ${FIXTURE_TOKEN}`,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.question).toBe("What medications is the patient on?");
    });

    it("rejects a question over 2000 characters", () => {
      const result = parseRequest(
        { capability: "QUESTION", question: "x".repeat(2001) },
        `Bearer ${FIXTURE_TOKEN}`,
      );
      expect(result.ok).toBe(false);
    });

    it("trims and returns undefined for empty/whitespace-only question", () => {
      const result = parseRequest(
        { capability: "QUESTION", question: "   " },
        `Bearer ${FIXTURE_TOKEN}`,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.question).toBeUndefined();
    });
  });
});
