// EXAM_GUIDANCE capability — validator regression suite.
//
// EXAM_GUIDANCE is on-demand only (PPMS_REQUEST_EXAM_GUIDANCE, answered via
// /api/copilot/stream) — it is NOT part of the consolidated call, so unlike
// differential-diagnosis.test.ts this exercises validateResponse() directly
// rather than the full generateCopilot() pipeline (there is no consolidated
// wiring here to prove).
//
// Output format: exactly two blocks, in order —
//   [Anterior Segment]
//   Documented: [...]
//   Associated findings not yet documented this visit: [...]
//
//   [Posterior Segment]
//   Documented: [...]
//   Associated findings not yet documented this visit: [...]
// — blank line between blocks. Or, when nothing in the record is relevant to
// correlate at all, the fixed sentence alone and nothing else.

import { describe, it, expect } from "vitest";
import { validateResponse } from "@/validation/response";
import type { Capability } from "@/capabilities";

const CAP = "EXAM_GUIDANCE" as Capability;

const WELL_FORMED_BOTH_SEGMENTS = `[Anterior Segment]
Documented: Photophobia and eye pain reported at V0 2024-06-15.
Associated findings not yet documented this visit: Anterior chamber reaction or ciliary flush, given the documented photophobia and eye pain.

[Posterior Segment]
Documented: No documented findings relevant to this segment.
Associated findings not yet documented this visit: None — insufficient documented findings to associate.`;

const NO_DATA_SENTENCE =
  "The documented record does not contain sufficient findings to correlate exam guidance at this time.";

describe("EXAM_GUIDANCE capability", () => {
  it("a well-formed response with both segments passes and extracts structured sections", () => {
    const r = validateResponse(WELL_FORMED_BOTH_SEGMENTS, CAP);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.examGuidanceSections).toEqual([
        {
          segment: "Anterior Segment",
          documented: "Photophobia and eye pain reported at V0 2024-06-15.",
          associatedFindingsNotDocumented:
            "Anterior chamber reaction or ciliary flush, given the documented photophobia and eye pain.",
        },
        {
          segment: "Posterior Segment",
          documented: "No documented findings relevant to this segment.",
          associatedFindingsNotDocumented: "None — insufficient documented findings to associate.",
        },
      ]);
    }
  });

  describe("imperative language is hard-rejected as RESPONSE_UNSAFE", () => {
    const imperativeCases = [
      "Check for corneal opacity given the documented photophobia.",
      "Examine the anterior chamber for cells and flare.",
      "Look for signs of ciliary flush.",
      "Assess intraocular pressure given documented eye pain.",
      "Rule out anterior uveitis based on the documented symptoms.",
      "Perform a slit-lamp examination of the anterior segment.",
      "Test for relative afferent pupillary defect.",
      "Evaluate the optic disc for cupping.",
      "Order a dilated fundus examination.",
      "Screen for diabetic retinopathy given the documented history.",
      "Investigate the posterior segment for vitreous haemorrhage.",
    ];

    for (const line of imperativeCases) {
      it(`rejects: "${line}"`, () => {
        const text = `[Anterior Segment]
Documented: Photophobia and eye pain reported at V0 2024-06-15.
Associated findings not yet documented this visit: ${line}

[Posterior Segment]
Documented: No documented findings relevant to this segment.
Associated findings not yet documented this visit: None — insufficient documented findings to associate.`;

        const r = validateResponse(text, CAP);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("RESPONSE_UNSAFE");
      });
    }
  });

  describe("malformed or missing segments are rejected as EXAM_GUIDANCE_STRUCTURE_INVALID", () => {
    it("only one segment block present (Posterior Segment missing entirely)", () => {
      const text = `[Anterior Segment]
Documented: Photophobia and eye pain reported at V0 2024-06-15.
Associated findings not yet documented this visit: Anterior chamber reaction, given the documented photophobia and eye pain.`;

      const r = validateResponse(text, CAP);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("EXAM_GUIDANCE_STRUCTURE_INVALID");
    });

    it("segments out of order (Posterior before Anterior)", () => {
      const text = `[Posterior Segment]
Documented: No documented findings relevant to this segment.
Associated findings not yet documented this visit: None — insufficient documented findings to associate.

[Anterior Segment]
Documented: Photophobia and eye pain reported at V0 2024-06-15.
Associated findings not yet documented this visit: Anterior chamber reaction, given the documented photophobia and eye pain.`;

      const r = validateResponse(text, CAP);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("EXAM_GUIDANCE_STRUCTURE_INVALID");
    });

    it("a segment missing its Documented line", () => {
      const text = `[Anterior Segment]
Associated findings not yet documented this visit: Anterior chamber reaction, given the documented photophobia and eye pain.

[Posterior Segment]
Documented: No documented findings relevant to this segment.
Associated findings not yet documented this visit: None — insufficient documented findings to associate.`;

      const r = validateResponse(text, CAP);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("EXAM_GUIDANCE_STRUCTURE_INVALID");
    });

    it("a segment missing its Associated-findings line", () => {
      const text = `[Anterior Segment]
Documented: Photophobia and eye pain reported at V0 2024-06-15.

[Posterior Segment]
Documented: No documented findings relevant to this segment.
Associated findings not yet documented this visit: None — insufficient documented findings to associate.`;

      const r = validateResponse(text, CAP);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("EXAM_GUIDANCE_STRUCTURE_INVALID");
    });

    it("unstructured free text with no block-shaped content at all", () => {
      const text =
        "Some free text describing the anterior and posterior segments informally, " +
        "without using the required structured block format the prompt specifies at all.";

      const r = validateResponse(text, CAP);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("EXAM_GUIDANCE_STRUCTURE_INVALID");
    });
  });

  describe("whole-response fallback sentence", () => {
    it("the exact fallback sentence alone passes, with zero structured sections", () => {
      const r = validateResponse(NO_DATA_SENTENCE, CAP);

      expect(r.ok).toBe(true);
      if (r.ok) expect(r.examGuidanceSections).toEqual([]);
    });

    it("the fallback sentence alongside other content is rejected — it must appear alone", () => {
      const text = `${NO_DATA_SENTENCE}

[Anterior Segment]
Documented: Photophobia and eye pain reported at V0 2024-06-15.
Associated findings not yet documented this visit: Anterior chamber reaction, given the documented photophobia and eye pain.`;

      const r = validateResponse(text, CAP);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("EXAM_GUIDANCE_STRUCTURE_INVALID");
    });
  });
});
