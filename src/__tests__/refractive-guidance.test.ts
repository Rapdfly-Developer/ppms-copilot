// REFRACTIVE_GUIDANCE capability — validator regression suite.
//
// On-demand only (same as EXAM_GUIDANCE) — exercises validateResponse()
// directly, matching exam-guidance.test.ts's style, since there is no
// consolidated wiring to prove here.
//
// The core safety property under test: the Routing block's four sub-tab
// claims are not free text — they are cross-checked against the REAL
// DocumentedFlags object passed as groundTruth.documented. The model phrases
// the sentence; it never gets to determine the fact. A response whose claim
// contradicts the ground truth must be rejected, not merely flagged.

import { describe, it, expect } from "vitest";
import { validateResponse } from "@/validation/response";
import type { Capability } from "@/capabilities";
import type { DocumentedFlags } from "@/lib/ppms-client";

const CAP = "REFRACTIVE_GUIDANCE" as Capability;

const ALL_DOCUMENTED: DocumentedFlags = {
  visualAcuity: true,
  refraction: true,
  anteriorSegment: false,
  posteriorSegment: false,
};

const WELL_FORMED = `[Right Eye]
Documented: Sph -3.00, Cyl -0.50, Axis 180 (Subjective), VA 6/9 unaided improving to 6/6 with correction, at V0 2024-06-15.
Refractive interpretation: Moderate myopia with mild astigmatism, consistent with the documented chief complaint of blurred vision.

[Left Eye]
Documented: No refraction or visual acuity documented for this eye at this visit.
Refractive interpretation: No refractive interpretation possible without documented refraction or visual acuity.

[Routing]
Visual Acuity: Documented
Refraction: Documented
Anterior Segment: Not documented
Posterior Segment: Not documented
Guidance: Anterior Segment and Posterior Segment have not yet been documented for this visit; Visual Acuity and Refraction are already recorded.`;

describe("REFRACTIVE_GUIDANCE capability", () => {
  it("a well-formed response with matching routing claims passes and extracts the structured result", () => {
    const r = validateResponse(WELL_FORMED, CAP, undefined, { documented: ALL_DOCUMENTED });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.refractiveGuidanceResult).toEqual({
        eyes: [
          {
            eye: "Right Eye",
            documented:
              "Sph -3.00, Cyl -0.50, Axis 180 (Subjective), VA 6/9 unaided improving to 6/6 with correction, at V0 2024-06-15.",
            interpretation:
              "Moderate myopia with mild astigmatism, consistent with the documented chief complaint of blurred vision.",
          },
          {
            eye: "Left Eye",
            documented: "No refraction or visual acuity documented for this eye at this visit.",
            interpretation:
              "No refractive interpretation possible without documented refraction or visual acuity.",
          },
        ],
        routing: {
          visualAcuityDocumented: true,
          refractionDocumented: true,
          anteriorSegmentDocumented: false,
          posteriorSegmentDocumented: false,
          guidance:
            "Anterior Segment and Posterior Segment have not yet been documented for this visit; " +
            "Visual Acuity and Refraction are already recorded.",
        },
      });
    }
  });

  describe("the core safety property: a routing claim contradicting the real boolean is rejected", () => {
    it("rejects when the model claims 'Documented' but the ground truth is false", () => {
      // Anterior Segment claimed Documented, but ALL_DOCUMENTED says false.
      const text = WELL_FORMED.replace("Anterior Segment: Not documented", "Anterior Segment: Documented");

      const r = validateResponse(text, CAP, undefined, { documented: ALL_DOCUMENTED });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("REFRACTIVE_GUIDANCE_STRUCTURE_INVALID");
    });

    it("rejects when the model claims 'Not documented' but the ground truth is true", () => {
      // Refraction claimed Not documented, but ALL_DOCUMENTED says true.
      const text = WELL_FORMED.replace("Refraction: Documented", "Refraction: Not documented");

      const r = validateResponse(text, CAP, undefined, { documented: ALL_DOCUMENTED });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("REFRACTIVE_GUIDANCE_STRUCTURE_INVALID");
    });

    it("passes when all four routing claims match a DIFFERENT ground truth (not hardcoded to one fixture)", () => {
      const allUndocumented: DocumentedFlags = {
        visualAcuity: false,
        refraction: false,
        anteriorSegment: true,
        posteriorSegment: true,
      };
      const text = `[Right Eye]
Documented: No refraction or visual acuity documented for this eye at this visit.
Refractive interpretation: No refractive interpretation possible without documented refraction or visual acuity.

[Left Eye]
Documented: No refraction or visual acuity documented for this eye at this visit.
Refractive interpretation: No refractive interpretation possible without documented refraction or visual acuity.

[Routing]
Visual Acuity: Not documented
Refraction: Not documented
Anterior Segment: Documented
Posterior Segment: Documented
Guidance: Visual Acuity and Refraction have not yet been documented for this visit; Anterior Segment and Posterior Segment are already recorded.`;

      const r = validateResponse(text, CAP, undefined, { documented: allUndocumented });

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.refractiveGuidanceResult?.routing).toEqual({
          visualAcuityDocumented: false,
          refractionDocumented: false,
          anteriorSegmentDocumented: true,
          posteriorSegmentDocumented: true,
          guidance:
            "Visual Acuity and Refraction have not yet been documented for this visit; " +
            "Anterior Segment and Posterior Segment are already recorded.",
        });
      }
    });

    it("rejects fail-closed when no ground truth is provided at all", () => {
      const r = validateResponse(WELL_FORMED, CAP, undefined, { documented: undefined });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("REFRACTIVE_GUIDANCE_STRUCTURE_INVALID");
    });
  });

  describe("imperative language is hard-rejected as RESPONSE_UNSAFE", () => {
    const imperativeCases = [
      "Check corneal clarity given the documented myopia.",
      "Examine the anterior chamber given the documented refractive error.",
      "Order a dilated fundus examination.",
      "Investigate the posterior segment for vitreous changes.",
    ];

    for (const line of imperativeCases) {
      it(`rejects: "${line}"`, () => {
        const text = WELL_FORMED.replace(
          "Moderate myopia with mild astigmatism, consistent with the documented chief complaint of blurred vision.",
          line,
        );

        const r = validateResponse(text, CAP, undefined, { documented: ALL_DOCUMENTED });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("RESPONSE_UNSAFE");
      });
    }
  });

  describe("malformed structure is rejected as REFRACTIVE_GUIDANCE_STRUCTURE_INVALID", () => {
    it("only two blocks present (Routing block missing entirely)", () => {
      const text = `[Right Eye]
Documented: Sph -3.00, Cyl -0.50, Axis 180 (Subjective), VA 6/9, at V0 2024-06-15.
Refractive interpretation: Moderate myopia.

[Left Eye]
Documented: No refraction or visual acuity documented for this eye at this visit.
Refractive interpretation: No refractive interpretation possible without documented refraction or visual acuity.`;

      const r = validateResponse(text, CAP, undefined, { documented: ALL_DOCUMENTED });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("REFRACTIVE_GUIDANCE_STRUCTURE_INVALID");
    });

    it("blocks out of order (Left Eye before Right Eye)", () => {
      const text = `[Left Eye]
Documented: No refraction or visual acuity documented for this eye at this visit.
Refractive interpretation: No refractive interpretation possible without documented refraction or visual acuity.

[Right Eye]
Documented: Sph -3.00, Cyl -0.50, Axis 180 (Subjective), VA 6/9, at V0 2024-06-15.
Refractive interpretation: Moderate myopia.

[Routing]
Visual Acuity: Documented
Refraction: Documented
Anterior Segment: Not documented
Posterior Segment: Not documented
Guidance: Anterior Segment and Posterior Segment have not yet been documented.`;

      const r = validateResponse(text, CAP, undefined, { documented: ALL_DOCUMENTED });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("REFRACTIVE_GUIDANCE_STRUCTURE_INVALID");
    });

    it("routing block missing a required sub-tab line", () => {
      const text = `[Right Eye]
Documented: Sph -3.00, Cyl -0.50, Axis 180 (Subjective), VA 6/9, at V0 2024-06-15.
Refractive interpretation: Moderate myopia.

[Left Eye]
Documented: No refraction or visual acuity documented for this eye at this visit.
Refractive interpretation: No refractive interpretation possible without documented refraction or visual acuity.

[Routing]
Visual Acuity: Documented
Refraction: Documented
Posterior Segment: Not documented
Guidance: Anterior Segment has not yet been documented.`;

      const r = validateResponse(text, CAP, undefined, { documented: ALL_DOCUMENTED });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("REFRACTIVE_GUIDANCE_STRUCTURE_INVALID");
    });

    it("routing block uses a value outside the fixed Documented/Not documented vocabulary", () => {
      const text = WELL_FORMED.replace("Anterior Segment: Not documented", "Anterior Segment: Partially documented");

      const r = validateResponse(text, CAP, undefined, { documented: ALL_DOCUMENTED });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("REFRACTIVE_GUIDANCE_STRUCTURE_INVALID");
    });

    it("unstructured free text with no block-shaped content at all", () => {
      const text =
        "Some free text describing the refractive status informally, without using the " +
        "required structured block format the prompt specifies at all.";

      const r = validateResponse(text, CAP, undefined, { documented: ALL_DOCUMENTED });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("REFRACTIVE_GUIDANCE_STRUCTURE_INVALID");
    });
  });

  describe("per-eye independent fallback", () => {
    it("both eyes using the fallback pair (no data documented at all) still passes", () => {
      const text = `[Right Eye]
Documented: No refraction or visual acuity documented for this eye at this visit.
Refractive interpretation: No refractive interpretation possible without documented refraction or visual acuity.

[Left Eye]
Documented: No refraction or visual acuity documented for this eye at this visit.
Refractive interpretation: No refractive interpretation possible without documented refraction or visual acuity.

[Routing]
Visual Acuity: Not documented
Refraction: Not documented
Anterior Segment: Not documented
Posterior Segment: Not documented
Guidance: None of the Ophthalmic sub-tabs have been documented for this visit yet.`;

      const noneDocumented: DocumentedFlags = {
        visualAcuity: false,
        refraction: false,
        anteriorSegment: false,
        posteriorSegment: false,
      };

      const r = validateResponse(text, CAP, undefined, { documented: noneDocumented });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.refractiveGuidanceResult?.eyes[0].documented).toBe(
          "No refraction or visual acuity documented for this eye at this visit.",
        );
        expect(r.refractiveGuidanceResult?.eyes[1].documented).toBe(
          "No refraction or visual acuity documented for this eye at this visit.",
        );
      }
    });

    it("one eye documented, the other using the fallback pair — independent per eye", () => {
      // WELL_FORMED already exercises exactly this: Right Eye has real data,
      // Left Eye uses the fallback pair. Re-asserted here explicitly.
      const r = validateResponse(WELL_FORMED, CAP, undefined, { documented: ALL_DOCUMENTED });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.refractiveGuidanceResult?.eyes[0].eye).toBe("Right Eye");
        expect(r.refractiveGuidanceResult?.eyes[0].documented).not.toBe(
          "No refraction or visual acuity documented for this eye at this visit.",
        );
        expect(r.refractiveGuidanceResult?.eyes[1].eye).toBe("Left Eye");
        expect(r.refractiveGuidanceResult?.eyes[1].documented).toBe(
          "No refraction or visual acuity documented for this eye at this visit.",
        );
      }
    });
  });
});
