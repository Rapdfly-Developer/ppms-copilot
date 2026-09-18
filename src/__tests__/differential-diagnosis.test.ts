// DIFFERENTIAL_DIAGNOSIS capability — permanent regression suite.
//
// Exercises the full real pipeline through the CONSOLIDATED code path
// (generateCopilot → context build → mock AI → validateResponse), matching how
// this capability actually runs in production now: as the 7th section of the
// single /api/copilot/generate request, alongside the other 6 tabs — not as a
// standalone /api/copilot/stream call. This proves the prompt/service/validator
// wiring for this capability stays intact inside the consolidated JSON response.
//
// Output format: one block per consideration —
//   **[Diagnosis name]**
//   [Reason — one line]
//   Confidence: [Low / Moderate]
//   Source: [optional — omitted entirely when not tied to a specific finding]
// — blank line between blocks. No leading section heading is required or
// expected: an earlier prompt version asked for a literal "## Possible
// Considerations for Review" heading before the first block, but
// openai/gpt-oss-120b reliably omitted it — live-reproduced 3/3 real API
// calls, well-formed blocks every time, heading never present — especially
// once this text is embedded as one JSON string value in the consolidated
// response rather than a standalone reply. The heading was never actually
// load-bearing for parsing (blocks are isolated starting from the beginning
// of the text either way), so the prompt no longer asks for one and the
// validator no longer requires one — it just tolerates one being present
// anyway (see test 4 below), in case a model ever includes it out of habit.
//
// Replaces an earlier single-line "- **Name** — confidence (citation)"
// format, which needed hardening twice against realistic model drift; this
// multi-line block format is parsed and validated field-by-field (see
// validateDifferentialDiagnosis in validation/response.ts) rather than via a
// single line-matching regex. That validator logic is capability-specific and
// transport-agnostic — it runs unchanged whether this capability arrives via
// the old standalone stream or the current consolidated JSON section.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { generateCopilot, type GenerateResponse } from "@/service/copilot-generate";
import { setProvider, resetProvider } from "@/ai";
import { CAPABILITY_CONFIG } from "@/capabilities";
import * as ppmsClient from "@/lib/ppms-client";
import type { AIProvider, AiResult, AiStreamEvent } from "@/ai/provider";
import {
  FIXTURE_PATIENT,
  FIXTURE_VISIT_CURRENT,
  FIXTURE_VISIT_PREVIOUS,
  FIXTURE_APPOINTMENTS,
  FIXTURE_TIMELINE,
  FIXTURE_TOKEN,
} from "./fixtures/patient";

// ── Mock AI provider ──────────────────────────────────────────────────────────
// generateCopilot() always uses provider.complete() (non-streaming, JSON mode)
// — stream() is required by the AIProvider interface but never called here.

function makeMockProvider(responseText: string): AIProvider {
  return {
    id: "mock",
    model: "mock-model",
    isConfigured: () => true,
    async complete(): Promise<AiResult> {
      return {
        text: responseText,
        model: "mock-model",
        provider: "mock",
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      };
    },
    async *stream(): AsyncIterable<AiStreamEvent> {
      yield { type: "text", text: responseText };
      yield {
        type: "done",
        model: "mock-model",
        provider: "mock",
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      };
    },
  };
}

async function generate(): Promise<GenerateResponse> {
  return generateCopilot(`Bearer ${FIXTURE_TOKEN}`);
}

// Safe, minimal, generically-valid placeholder text for the 6 sections this
// suite isn't testing — just needs to be non-empty and not trip any safety
// pattern. draftNote needs all four SOAP headings to pass NOTE_ASSISTANCE's
// structural check.
const SAFE_OTHER_SECTIONS = {
  snapshot: "Documented and stable; no acute findings reported at this visit.",
  previousVisits: "Documented history consistent with prior visits; no new findings.",
  timeline: "Documented visit history spans multiple prior encounters.",
  attention: "No documented changes requiring attention at this time.",
  draftNote:
    "## Subjective:\nStable per documentation.\n## Objective:\nStable per documentation.\n" +
    "## Assessment:\nStable per documentation.\n## Plan:\nContinue as documented.",
  followUp: "Documented follow-up plan continues as previously recorded.",
  medications: "No medications documented at this visit.",
  investigations: "No investigations documented in the record.",
  assessmentContext:
    "## Current Diagnoses\nNo diagnoses documented.\n\n## Clinical Status Summary\nNo diagnoses or clinical context documented at this visit.",
  suggestedQuestions: "No significant documentation gaps identified.",
};

// Builds the raw JSON text the mock AI "returns" for the consolidated call —
// the 6 safe placeholder sections plus the differentialDiagnosis text under
// test. JSON.stringify handles all escaping, so fixture text below can be
// written as plain multi-line template literals with no manual escaping.
function buildConsolidatedResponseText(differentialDiagnosisText: string): string {
  return JSON.stringify({ ...SAFE_OTHER_SECTIONS, differentialDiagnosis: differentialDiagnosisText });
}

// ── Fixture response texts — one per scenario ─────────────────────────────────
// No leading heading (matches current prompt/model reality — see file header)
// and no trailing disclaimer paragraph (that messaging now lives only in the
// UI's shared footer, not in AI-generated output).

// 1. Well-formed block WITH a Source (citation) line.
const WELL_FORMED_WITH_CITATION = `**Anterior uveitis**
Documented photophobia and eye pain are consistent with anterior segment inflammation.
Confidence: Moderate
Source: V0 2024-06-15`;

// 2. Well-formed block WITHOUT a Source line — general clinical reasoning,
// not tied to a specific documented finding. Citation is optional by design.
const WELL_FORMED_WITHOUT_CITATION = `**Early cataract changes**
Gradual blurring of vision is a general pattern consistent with early lens changes.
Confidence: Low`;

// Multi-item list mixing a cited and an uncited block — both forms in one response.
const MULTI_ITEM_MIXED = `**Anterior uveitis**
Documented photophobia and eye pain are consistent with anterior segment inflammation.
Confidence: Moderate
Source: V0 2024-06-15

**Early cataract changes**
Gradual blurring of vision is a general pattern consistent with early lens changes.
Confidence: Low`;

// 4. A well-formed response that still includes the old "## Possible
// Considerations for Review" heading before the first block — simulating a
// model that includes it out of habit or drift despite the prompt no longer
// asking for it. Must still pass: the heading is tolerated, not required.
const WELL_FORMED_WITH_STALE_HEADING = `## Possible Considerations for Review
**Anterior uveitis**
Documented photophobia and eye pain are consistent with anterior segment inflammation.
Confidence: Moderate
Source: V0 2024-06-15`;

// 5. Missing reason line — Confidence line comes directly after the name.
const MISSING_REASON_LINE = `**Anterior uveitis**
Confidence: Moderate
Source: V0 2024-06-15`;

// 6. Missing Confidence line — Source line comes directly after the reason.
const MISSING_CONFIDENCE_LINE = `**Anterior uveitis**
Documented photophobia and eye pain reported.
Source: V0 2024-06-15`;

// 7. Confidence line present but with a value outside "Low" / "Moderate".
const INVALID_CONFIDENCE_VALUE = `**Anterior uveitis**
Documented photophobia and eye pain reported.
Confidence: Medium`;

// 8. Certainty language — hard-rejected regardless of block structure.
const CERTAINTY_LANGUAGE = `**Anterior uveitis**
This is a confirmed diagnosis based on the documented findings.
Confidence: Moderate
Source: V0 2024-06-15`;

// 9. Prescriptive/treatment language mixed into an otherwise well-formed response.
const PRESCRIPTIVE_LANGUAGE_MIXED_IN = `**Anterior uveitis**
Documented photophobia and eye pain reported.
Confidence: Moderate
Source: V0 2024-06-15

I recommend starting topical steroids immediately.`;

// 10. Malformed/drifted block — two considerations run together without a
// blank line between them, so they parse as a single 6-line block instead
// of two valid 4-line blocks. Rejected by the block length bound.
const MALFORMED_DRIFTED_BLOCK = `**Anterior uveitis**
Documented photophobia and eye pain reported.
Confidence: Moderate
**Episcleritis**
Documented redness without discharge.
Confidence: Low`;

// 11. Unstructured free text with no block-shaped content at all — no bold
// name lines, no Confidence lines. Since no heading is required anymore,
// this is rejected purely because nothing in it parses as a valid block
// (not because a heading is missing).
const UNSTRUCTURED_FREE_TEXT_NO_BLOCKS =
  "Some free text response describing possible considerations informally, without using " +
  "the required structured block format the prompt specifies at all.";

// 12. Exact insufficient-evidence sentence, zero blocks.
const NO_EVIDENCE_SENTENCE =
  "The documented record does not contain sufficient findings to support any diagnostic considerations at this time.";

// 13. A well-intentioned reason that wraps across two lines with a hard
// newline (no blank line before Confidence) — not a separate field, just a
// long sentence that broke mid-clause. Must still pass: the reason is
// reconstructed from every line before the Confidence line, however many.
const WRAPPED_REASON_NO_SOURCE = `**Anterior uveitis**
Documented photophobia and eye pain are consistent with
anterior segment inflammation, warranting consideration.
Confidence: Moderate`;

// 17. Blank line WITHIN a block between reason and Confidence — the model
// inserts this when generating differentialDiagnosis as one JSON value inside
// the larger 7-section consolidated response, picking up the spaced-paragraph
// style it uses elsewhere in the same document. Must pass: the orphaned tail
// fragment (starting with "Confidence:") is re-attached to its preceding block.
const BLANK_LINE_WITHIN_BLOCK = `**Anterior uveitis**
Documented photophobia and eye pain are consistent with anterior segment inflammation.

Confidence: Moderate
Source: V0 2024-06-15`;

// 18. Blank line within EACH block of a multi-item list — both are re-attached
// and both must pass independently.
const BLANK_LINE_WITHIN_EACH_BLOCK = `**Anterior uveitis**
Documented photophobia and eye pain are consistent with anterior segment inflammation.

Confidence: Moderate
Source: V0 2024-06-15

**Early cataract changes**
Gradual blurring of vision is a general pattern consistent with early lens changes.

Confidence: Low`;

// 14. An abandoned/malformed fragment alongside the exact refusal sentence —
// the fragment must not be able to hide behind a valid refusal elsewhere in
// the same section. Fail closed rather than letting noEvidence short-circuit.
const ABANDONED_FRAGMENT_WITH_REFUSAL_SENTENCE = `**Possible glau

The documented record does not contain sufficient findings to support any diagnostic considerations at this time.`;

// ── Test setup — mirrors capability-service.test.ts exactly ───────────────────

beforeEach(() => {
  process.env.PPMS_CORE_URL = "http://ppms-test.internal";
  vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
  vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
  vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([FIXTURE_VISIT_PREVIOUS]);
  vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue(FIXTURE_APPOINTMENTS);
  vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue(FIXTURE_TIMELINE);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProvider();
  delete process.env.PPMS_CORE_URL;
});

describe("DIFFERENTIAL_DIAGNOSIS capability (consolidated path)", () => {
  it("1. well-formed block WITH a citation (Source line), no heading, passes", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(WELL_FORMED_WITH_CITATION)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(true);
    }
  });

  it("2. well-formed block WITHOUT a citation (no Source line) also passes — citation is optional", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(WELL_FORMED_WITHOUT_CITATION)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(true);
    }
  });

  it("multi-item list mixing a cited and an uncited block passes", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(MULTI_ITEM_MIXED)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(true);
    }
  });

  it("4. a response that still includes the old heading (model drift/habit) is tolerated, not rejected", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(WELL_FORMED_WITH_STALE_HEADING)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(true);
    }
  });

  it("5. a block missing its reason line is rejected as DIFFERENTIAL_STRUCTURE_INVALID", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(MISSING_REASON_LINE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(false);
      if (!result.data.differentialDiagnosis.ok) {
        expect(result.data.differentialDiagnosis.errorCode).toBe("DIFFERENTIAL_STRUCTURE_INVALID");
      }
    }
  });

  it("6. a block missing its Confidence line is rejected as DIFFERENTIAL_STRUCTURE_INVALID", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(MISSING_CONFIDENCE_LINE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(false);
      if (!result.data.differentialDiagnosis.ok) {
        expect(result.data.differentialDiagnosis.errorCode).toBe("DIFFERENTIAL_STRUCTURE_INVALID");
      }
    }
  });

  it("7. a Confidence value outside Low/Moderate is rejected as DIFFERENTIAL_STRUCTURE_INVALID", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(INVALID_CONFIDENCE_VALUE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(false);
      if (!result.data.differentialDiagnosis.ok) {
        expect(result.data.differentialDiagnosis.errorCode).toBe("DIFFERENTIAL_STRUCTURE_INVALID");
      }
    }
  });

  it("8. certainty language is rejected as RESPONSE_UNSAFE regardless of block structure", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(CERTAINTY_LANGUAGE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(false);
      if (!result.data.differentialDiagnosis.ok) {
        expect(result.data.differentialDiagnosis.errorCode).toBe("RESPONSE_UNSAFE");
      }
    }
  });

  it("9. prescriptive/treatment language mixed in is rejected as RESPONSE_UNSAFE (universal check, unchanged)", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(PRESCRIPTIVE_LANGUAGE_MIXED_IN)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(false);
      if (!result.data.differentialDiagnosis.ok) {
        expect(result.data.differentialDiagnosis.errorCode).toBe("RESPONSE_UNSAFE");
      }
    }
  });

  it("10. a malformed/drifted block (two considerations run together) is rejected as DIFFERENTIAL_STRUCTURE_INVALID", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(MALFORMED_DRIFTED_BLOCK)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(false);
      if (!result.data.differentialDiagnosis.ok) {
        expect(result.data.differentialDiagnosis.errorCode).toBe("DIFFERENTIAL_STRUCTURE_INVALID");
      }
    }
  });

  it("11. unstructured free text with no block-shaped content is rejected as DIFFERENTIAL_STRUCTURE_INVALID", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(UNSTRUCTURED_FREE_TEXT_NO_BLOCKS)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(false);
      if (!result.data.differentialDiagnosis.ok) {
        expect(result.data.differentialDiagnosis.errorCode).toBe("DIFFERENTIAL_STRUCTURE_INVALID");
      }
    }
  });

  it("12. the exact insufficient-evidence sentence with zero blocks passes", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(NO_EVIDENCE_SENTENCE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(true);
    }
  });

  it("13. a reason that wraps across two lines with a hard newline (no blank line before Confidence) passes", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(WRAPPED_REASON_NO_SOURCE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(true);
    }
  });

  it("14. an abandoned fragment alongside the refusal sentence is rejected — the valid sentence does not mask it", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(ABANDONED_FRAGMENT_WITH_REFUSAL_SENTENCE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(false);
      if (!result.data.differentialDiagnosis.ok) {
        expect(result.data.differentialDiagnosis.errorCode).toBe("DIFFERENTIAL_STRUCTURE_INVALID");
      }
    }
  });

  it("15. a malformed differentialDiagnosis section does not invalidate the other 6 sections", async () => {
    // The core architectural property of the consolidated response: each
    // section is validated independently, so one bad section degrades
    // gracefully instead of discarding the whole visit's AI output — unlike
    // the old standalone-stream path, where a validation failure meant the
    // entire single-capability response was discarded.
    setProvider(makeMockProvider(buildConsolidatedResponseText(UNSTRUCTURED_FREE_TEXT_NO_BLOCKS)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(false);
      expect(result.data.snapshot.ok).toBe(true);
      expect(result.data.previousVisits.ok).toBe(true);
      expect(result.data.timeline.ok).toBe(true);
      expect(result.data.attention.ok).toBe(true);
      expect(result.data.draftNote.ok).toBe(true);
      expect(result.data.followUp.ok).toBe(true);
    }
  });

  it("17. blank line within a block between reason and Confidence is tolerated — orphaned tail is re-attached", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(BLANK_LINE_WITHIN_BLOCK)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(true);
    }
  });

  it("18. blank line within each block of a multi-item list — all blocks re-attached and pass", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(BLANK_LINE_WITHIN_EACH_BLOCK)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.differentialDiagnosis.ok).toBe(true);
    }
  });

  it("16. DIFFERENTIAL_DIAGNOSIS no longer requires the strong disclaimer banner", () => {
    // The red "This is NOT a diagnosis" banner (ResponseArea's StrongDisclaimer)
    // was driven entirely by this config flag. It's been removed from the UI
    // as redundant with the shared footer disclaimer shown on every tab — this
    // asserts the flag itself is gone too, not just unused, so a future capability
    // can't silently inherit a stale "true" default via this config's shape.
    expect(
      Object.prototype.hasOwnProperty.call(CAPABILITY_CONFIG.DIFFERENTIAL_DIAGNOSIS, "requiresStrongDisclaimer"),
    ).toBe(false);
  });
});
