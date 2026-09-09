import { describe, it, expect } from "vitest";
import { validateResponse } from "@/validation/response";
import type { Capability } from "@/capabilities";

const CAP = "PATIENT_SNAPSHOT" as Capability;

describe("Response validation", () => {
  describe("Mechanical checks", () => {
    it("rejects empty string", () => {
      const r = validateResponse("", CAP);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("RESPONSE_EMPTY");
    });

    it("rejects string under 20 characters", () => {
      const r = validateResponse("Short.", CAP);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("RESPONSE_EMPTY");
    });

    it("rejects truncated response (stopReason=max_tokens)", () => {
      const r = validateResponse("This is a valid length response.", CAP, "max_tokens");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("RESPONSE_TRUNCATED");
    });

    it("accepts a response with stopReason=end_turn", () => {
      const r = validateResponse(
        "The patient has documented glaucoma in the right eye.",
        CAP,
        "end_turn",
      );
      expect(r.ok).toBe(true);
    });
  });

  describe("Unsafe patterns (hard reject)", () => {
    const unsafePhrases = [
      "I recommend you take this medication.",
      "You should start timolol eye drops.",
      "You should stop the current treatment.",
      "I diagnose this patient with glaucoma.",
      "I prescribe latanoprost drops.",
      "The diagnosis is primary open-angle glaucoma.",
      "This patient definitely has retinal detachment.",
      "Change the dose to 20mg daily.",
      "Start treatment with latanoprost.",
      "Add timolol to the regimen.",
    ];

    for (const phrase of unsafePhrases) {
      it(`rejects: "${phrase.slice(0, 60)}..."`, () => {
        const r = validateResponse(
          `Clinical summary. ${phrase} Based on documented record.`,
          CAP,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("RESPONSE_UNSAFE");
      });
    }

    it("case-insensitive matching on unsafe patterns", () => {
      // "I recommend starting treatment with" is a genuinely unsafe prescription phrase
      // that is NOT rewritten by the sanitiser (no benign-rewrite rule covers it)
      const r = validateResponse("i recommend starting treatment with latanoprost.", CAP);
      expect(r.ok).toBe(false);
    });
  });

  describe("Warning patterns (soft — response allowed)", () => {
    const warningPhrases = [
      "The documented findings likely indicate progression.",
      "The patient probably has a secondary issue.",
      "Consider starting a second agent (as documented by the physician).",
      "The medication may indicate the doctor's concern.",
    ];

    for (const phrase of warningPhrases) {
      it(`warns but allows: "${phrase.slice(0, 50)}..."`, () => {
        const r = validateResponse(
          `The patient has documented glaucoma. ${phrase} This is based only on documented records.`,
          CAP,
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.warnings.length).toBeGreaterThan(0);
      });
    }
  });

  describe("Safe responses (no issues)", () => {
    it("accepts a clean ophthalmology summary", () => {
      const r = validateResponse(
        "The documented record shows a 52-year-old male with primary open-angle glaucoma " +
          "in the right eye, confirmed. Current medication: Timolol 0.5% drops bilaterally, " +
          "twice daily. Vitals within normal documented range. Follow-up scheduled for September.",
        CAP,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.warnings).toHaveLength(0);
    });
  });

  describe("NOTE_ASSISTANCE — SOAP section requirement", () => {
    const noteCapability = "NOTE_ASSISTANCE" as Capability;

    it("rejects a note without all four SOAP sections", () => {
      const r = validateResponse(
        "Subjective: Patient reports stable vision.\nObjective: Vitals normal.\nAssessment: Glaucoma.",
        noteCapability,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("NOTE_INCOMPLETE");
        expect(r.reason).toContain("Plan:");
      }
    });

    it("rejects a note missing Subjective section", () => {
      const r = validateResponse(
        "Objective: Normal vitals.\nAssessment: Glaucoma documented.\nPlan: Continue drops.",
        noteCapability,
      );
      expect(r.ok).toBe(false);
    });

    it("accepts a note with all four SOAP sections", () => {
      const note = [
        "Subjective: Patient reports stable vision, no pain.",
        "Objective: IOP documented at last visit. Vitals: BP 128/82.",
        "Assessment: Primary open-angle glaucoma (confirmed, right eye).",
        "Plan: Continue Timolol 0.5% drops bilaterally. Review after OCT.",
      ].join("\n\n");
      const r = validateResponse(note, noteCapability);
      expect(r.ok).toBe(true);
    });
  });
});
