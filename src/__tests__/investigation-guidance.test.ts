// INVESTIGATION_GUIDANCE capability — permanent regression suite.
//
// Exercises the full real pipeline through the CONSOLIDATED code path
// (generateCopilot → context build → mock AI → validateResponse), same as
// plan-guidance.test.ts — INVESTIGATION_GUIDANCE is eager/consolidated.
//
// Output format: a variable-length list of suggestion blocks —
//   **[Investigation name]**
//   [Correlative rationale — one line]
//   Confidence: [Low / Moderate]
//   Source: [optional — omitted entirely when not tied to a specific finding]
// — blank line between blocks, or the fixed no-suggestion sentence when
// nothing correlates. Structurally the same parser shape as
// differential-diagnosis.test.ts (validateInvestigationGuidance reuses the
// same wrap-tolerant block-parsing approach as validateDifferentialDiagnosis).
//
// The core safety property under test: correlative framing only — never an
// imperative (shared IMPERATIVE_LANGUAGE_PATTERNS) and never a non-imperative
// but still directive/requirement construction (dedicated
// DIRECTIVE_LANGUAGE_PATTERNS) — plus the pure-reuse threading of
// investigationsSummary from the already-validated INVESTIGATIONS_SUMMARY
// section, same "omit rather than show broken" pattern as
// PlanGuidanceResult.followUpSummary.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { generateCopilot, type GenerateResponse } from "@/service/copilot-generate";
import { setProvider, resetProvider } from "@/ai";
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

const SAFE_OTHER_SECTIONS = {
  timeline: "Documented visit history spans multiple prior encounters.",
  attention: "No documented changes requiring attention at this time.",
  draftNote:
    "## Subjective:\nStable per documentation.\n## Objective:\nStable per documentation.\n" +
    "## Assessment:\nStable per documentation.\n## Plan:\nContinue as documented.",
  followUp: "Documented follow-up plan continues as previously recorded.",
  differentialDiagnosis:
    "The documented record does not contain sufficient findings to support any diagnostic considerations at this time.",
  medications: "No medications documented at this visit.",
  investigations: "No investigations documented in the record.",
  assessmentContext:
    "## Current Diagnoses\nNo diagnoses documented.\n\n## Clinical Status Summary\nNo diagnoses or clinical context documented at this visit.",
  suggestedQuestions: "No significant documentation gaps identified.",
  planGuidance: "[Documented Progression]\nProgression: No documented medication or diagnosis changes across visits to describe.\n\n[Comforting Methods]\nGuidance: No specific patient concerns are documented to correlate reassurance guidance to at this time.",
};

function buildConsolidatedResponseText(
  investigationGuidanceText: string,
  overrides: Partial<typeof SAFE_OTHER_SECTIONS> = {},
): string {
  return JSON.stringify({
    ...SAFE_OTHER_SECTIONS,
    ...overrides,
    investigationGuidance: investigationGuidanceText,
  });
}

// ── Fixture response texts ────────────────────────────────────────────────────

const WELL_FORMED_SINGLE_SUGGESTION = `**Optical Coherence Tomography (OCT)**
Documented gradual central vision distortion is consistent with a clinical picture where OCT is commonly used to assess retinal layer changes.
Confidence: Moderate
Source: V0 2024-06-15`;

const WELL_FORMED_MULTI_SUGGESTION = `${WELL_FORMED_SINGLE_SUGGESTION}

**Visual Field Test**
Documented glaucoma history is consistent with a clinical picture where visual field testing is commonly used to monitor progression.
Confidence: Low`;

const NO_SUGGESTION_SENTENCE =
  "No additional investigations are suggested based on the documented record at this time.";

const IMPERATIVE_LANGUAGE = `**Optical Coherence Tomography (OCT)**
Order an OCT given the documented findings.
Confidence: Moderate`;

const DIRECTIVE_SHOULD_UNDERGO = `**Optical Coherence Tomography (OCT)**
The patient should undergo an OCT given the documented findings.
Confidence: Moderate`;

const DIRECTIVE_NEEDS = `**Optical Coherence Tomography (OCT)**
The documented findings mean the patient needs an OCT.
Confidence: Moderate`;

const DIRECTIVE_REQUIRES = `**Optical Coherence Tomography (OCT)**
The documented findings mean an OCT requires scheduling.
Confidence: Moderate`;

const DIRECTIVE_MUST_BE_ORDERED = `**Optical Coherence Tomography (OCT)**
Given the documented findings, an OCT must be ordered.
Confidence: Moderate`;

const DIRECTIVE_IS_INDICATED = `**Optical Coherence Tomography (OCT)**
Given the documented findings, an OCT is indicated.
Confidence: Moderate`;

const MISSING_CONFIDENCE_LINE = `**Optical Coherence Tomography (OCT)**
Documented findings are consistent with a clinical picture where OCT is commonly used.`;

const UNSTRUCTURED_FREE_TEXT =
  "Some free text describing possible investigations informally, without using the " +
  "required structured block format the prompt specifies at all.";

// ── Test setup ────────────────────────────────────────────────────────────────

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

describe("INVESTIGATION_GUIDANCE capability (consolidated path)", () => {
  it("a well-formed single-suggestion response passes and parses the structured item", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(WELL_FORMED_SINGLE_SUGGESTION)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.investigationGuidance.ok).toBe(true);
      if (result.data.investigationGuidance.ok) {
        const r = result.data.investigationGuidance.investigationGuidanceResult;
        expect(r?.suggestedInvestigations).toEqual([
          {
            name: "Optical Coherence Tomography (OCT)",
            rationale:
              "Documented gradual central vision distortion is consistent with a clinical picture where OCT is commonly used to assess retinal layer changes.",
            confidence: "Moderate",
            source: "V0 2024-06-15",
          },
        ]);
      }
    }
  });

  it("a well-formed multi-suggestion response passes, including an item with no Source line", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(WELL_FORMED_MULTI_SUGGESTION)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.investigationGuidance.ok).toBe(true);
      if (result.data.investigationGuidance.ok) {
        const r = result.data.investigationGuidance.investigationGuidanceResult;
        expect(r?.suggestedInvestigations).toHaveLength(2);
        expect(r?.suggestedInvestigations[1]).toEqual({
          name: "Visual Field Test",
          rationale:
            "Documented glaucoma history is consistent with a clinical picture where visual field testing is commonly used to monitor progression.",
          confidence: "Low",
        });
      }
    }
  });

  it("the fixed no-suggestion sentence passes with an empty suggestedInvestigations list", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(NO_SUGGESTION_SENTENCE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.investigationGuidance.ok).toBe(true);
      if (result.data.investigationGuidance.ok) {
        expect(result.data.investigationGuidance.investigationGuidanceResult?.suggestedInvestigations).toEqual([]);
      }
    }
  });

  it("imperative language is rejected as RESPONSE_UNSAFE", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(IMPERATIVE_LANGUAGE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.investigationGuidance.ok).toBe(false);
      if (!result.data.investigationGuidance.ok) {
        expect(result.data.investigationGuidance.errorCode).toBe("RESPONSE_UNSAFE");
      }
    }
  });

  describe("directive/requirement language is rejected as RESPONSE_UNSAFE", () => {
    const cases: [string, string][] = [
      ["should undergo", DIRECTIVE_SHOULD_UNDERGO],
      ["needs", DIRECTIVE_NEEDS],
      ["requires", DIRECTIVE_REQUIRES],
      ["must be ordered", DIRECTIVE_MUST_BE_ORDERED],
      ["is indicated", DIRECTIVE_IS_INDICATED],
    ];

    for (const [label, text] of cases) {
      it(`rejects "${label}"`, async () => {
        setProvider(makeMockProvider(buildConsolidatedResponseText(text)));
        const result = await generate();
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.investigationGuidance.ok).toBe(false);
          if (!result.data.investigationGuidance.ok) {
            expect(result.data.investigationGuidance.errorCode).toBe("RESPONSE_UNSAFE");
          }
        }
      });
    }
  });

  describe("malformed structure is rejected as INVESTIGATION_GUIDANCE_STRUCTURE_INVALID", () => {
    it("missing Confidence line", async () => {
      setProvider(makeMockProvider(buildConsolidatedResponseText(MISSING_CONFIDENCE_LINE)));
      const result = await generate();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.investigationGuidance.ok).toBe(false);
        if (!result.data.investigationGuidance.ok) {
          expect(result.data.investigationGuidance.errorCode).toBe("INVESTIGATION_GUIDANCE_STRUCTURE_INVALID");
        }
      }
    });

    it("unstructured free text with no block-shaped content at all", async () => {
      setProvider(makeMockProvider(buildConsolidatedResponseText(UNSTRUCTURED_FREE_TEXT)));
      const result = await generate();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.investigationGuidance.ok).toBe(false);
        if (!result.data.investigationGuidance.ok) {
          expect(result.data.investigationGuidance.errorCode).toBe("INVESTIGATION_GUIDANCE_STRUCTURE_INVALID");
        }
      }
    });
  });

  it("a malformed investigationGuidance section does not invalidate the other 12 sections", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(UNSTRUCTURED_FREE_TEXT)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.investigationGuidance.ok).toBe(false);
      expect(result.data.differentialDiagnosis.ok).toBe(true);
      expect(result.data.planGuidance.ok).toBe(true);
      expect(result.data.investigations.ok).toBe(true);
    }
  });

  // ── investigationsSummary threading (pure reuse, no new AI call) ───────────

  it("investigationsSummary is threaded from the INVESTIGATIONS_SUMMARY section's own validated text", async () => {
    const distinctInvestigationsText = "- **OCT** (imaging) — Status: completed — Ordered: V1 2024-01-15";
    setProvider(
      makeMockProvider(
        buildConsolidatedResponseText(NO_SUGGESTION_SENTENCE, { investigations: distinctInvestigationsText }),
      ),
    );

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.investigations.ok).toBe(true);
      expect(result.data.investigationGuidance.ok).toBe(true);
      if (result.data.investigationGuidance.ok) {
        expect(result.data.investigationGuidance.investigationGuidanceResult?.investigationsSummary).toBe(
          distinctInvestigationsText,
        );
      }
    }
  });

  it("investigationsSummary is omitted (not an error) when INVESTIGATIONS_SUMMARY itself fails validation", async () => {
    setProvider(
      makeMockProvider(buildConsolidatedResponseText(NO_SUGGESTION_SENTENCE, { investigations: "too short" })),
    );

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.investigations.ok).toBe(false);
      expect(result.data.investigationGuidance.ok).toBe(true);
      if (result.data.investigationGuidance.ok) {
        expect(result.data.investigationGuidance.investigationGuidanceResult).toEqual({
          suggestedInvestigations: [],
        });
      }
    }
  });
});
