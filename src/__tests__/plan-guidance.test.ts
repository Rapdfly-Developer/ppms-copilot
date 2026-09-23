// PLAN_GUIDANCE capability — permanent regression suite.
//
// Exercises the full real pipeline through the CONSOLIDATED code path
// (generateCopilot → context build → mock AI → validateResponse), same as
// differential-diagnosis.test.ts — PLAN_GUIDANCE is eager/consolidated,
// unlike EXAM_GUIDANCE/REFRACTIVE_GUIDANCE.
//
// Output format: two required blocks, plus an optional third —
//   [Documented Progression]
//   Progression: [retrospective-only description of documented med/diagnosis changes]
//
//   [Comforting Methods]
//   Guidance: [general reassurance framing]
//
//   [Govt Scheme]   (ONLY when matchGovtScheme() found a match for the visit's diagnoses)
//   Scheme: [verbatim]
//   Description: [verbatim]
//   Eligibility: [verbatim]
//   Last verified: [verbatim]
//
// The core safety property under test: the Govt Scheme block, when present,
// must exactly match the real GovtSchemeEntry the server matched — the model
// cites, it never composes — and must be ABSENT entirely (not a fallback
// sentence) when no match was found, matching "fail closed, omit rather than
// guess" discipline.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { generateCopilot, type GenerateResponse } from "@/service/copilot-generate";
import { setProvider, resetProvider } from "@/ai";
import * as ppmsClient from "@/lib/ppms-client";
import { GOVT_SCHEMES } from "@/lib/govt-schemes";
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
};

function buildConsolidatedResponseText(planGuidanceText: string): string {
  return JSON.stringify({ ...SAFE_OTHER_SECTIONS, planGuidance: planGuidanceText });
}

// Same as buildConsolidatedResponseText, but lets a test override the
// followUp section's own text — used to prove followUpSummary is sourced
// from that section's actual content (not a hardcoded pass-through), and to
// simulate followUp itself failing validation.
function buildConsolidatedResponseTextWithFollowUp(planGuidanceText: string, followUpText: string): string {
  return JSON.stringify({ ...SAFE_OTHER_SECTIONS, followUp: followUpText, planGuidance: planGuidanceText });
}

// ── Fixture response texts ────────────────────────────────────────────────────

const NO_SCHEME_WELL_FORMED = `[Documented Progression]
Progression: Timolol 0.5% documented from V1 2023-12-10; continued through V0 2024-06-15.

[Comforting Methods]
Guidance: Patients documented with stable glaucoma monitoring are often reassured to learn regular follow-up detects change early.`;

const WITH_SCHEME_ENTRY = GOVT_SCHEMES[0]; // ab-pmjay

const WITH_SCHEME_WELL_FORMED = `${NO_SCHEME_WELL_FORMED}

[Govt Scheme]
Scheme: ${WITH_SCHEME_ENTRY.schemeName}
Description: ${WITH_SCHEME_ENTRY.description}
Eligibility: ${WITH_SCHEME_ENTRY.eligibilitySummary}
Last verified: ${WITH_SCHEME_ENTRY.lastVerified}`;

const SCHEME_WITH_WRONG_FIELD = `${NO_SCHEME_WELL_FORMED}

[Govt Scheme]
Scheme: ${WITH_SCHEME_ENTRY.schemeName}
Description: A completely different, fabricated description of the scheme.
Eligibility: ${WITH_SCHEME_ENTRY.eligibilitySummary}
Last verified: ${WITH_SCHEME_ENTRY.lastVerified}`;

const SCHEME_BLOCK_WITHOUT_MATCH = WITH_SCHEME_WELL_FORMED; // used against a non-matching visit

const FALLBACK_SENTENCES = `[Documented Progression]
Progression: No documented medication or diagnosis changes across visits to describe.

[Comforting Methods]
Guidance: No specific patient concerns are documented to correlate reassurance guidance to at this time.`;

const IMPERATIVE_LANGUAGE = `[Documented Progression]
Progression: Order an updated IOP check given the documented glaucoma history.

[Comforting Methods]
Guidance: Patients are often reassured by regular monitoring.`;

const PROSPECTIVE_LANGUAGE_NEXT_STEP = `[Documented Progression]
Progression: Timolol documented from V1 2023-12-10. The next step would be to add a second agent.

[Comforting Methods]
Guidance: Patients are often reassured by regular monitoring.`;

const PROSPECTIVE_LANGUAGE_IF_FAILS = `[Documented Progression]
Progression: Timolol documented from V1 2023-12-10. If Timolol fails, try Latanoprost next.

[Comforting Methods]
Guidance: Patients are often reassured by regular monitoring.`;

const MISSING_COMFORTING_BLOCK = `[Documented Progression]
Progression: Timolol 0.5% documented from V1 2023-12-10; continued through V0 2024-06-15.`;

const BLOCKS_OUT_OF_ORDER = `[Comforting Methods]
Guidance: Patients are often reassured by regular monitoring.

[Documented Progression]
Progression: Timolol 0.5% documented from V1 2023-12-10; continued through V0 2024-06-15.`;

const UNSTRUCTURED_FREE_TEXT =
  "Some free text describing treatment progression and reassurance informally, " +
  "without using the required structured block format the prompt specifies at all.";

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

describe("PLAN_GUIDANCE capability (consolidated path)", () => {
  it("a well-formed 2-block response (no govt scheme match) passes", async () => {
    // FIXTURE_VISIT_CURRENT's diagnosis (Primary open-angle glaucoma, H40.11)
    // matches neither GOVT_SCHEMES entry — confirms the no-match path.
    setProvider(makeMockProvider(buildConsolidatedResponseText(NO_SCHEME_WELL_FORMED)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.planGuidance.ok).toBe(true);
      if (result.data.planGuidance.ok) {
        expect(result.data.planGuidance.planGuidanceResult).toEqual({
          documentedProgression:
            "Timolol 0.5% documented from V1 2023-12-10; continued through V0 2024-06-15.",
          followUpSummary: SAFE_OTHER_SECTIONS.followUp,
          comfortingGuidance:
            "Patients documented with stable glaucoma monitoring are often reassured to learn regular follow-up detects change early.",
        });
      }
    }
  });

  it("followUpSummary is threaded from the FOLLOW_UP_SUMMARY section's own validated text, not regenerated", async () => {
    const distinctFollowUpText = "Documented follow-up plan: return in 6 weeks per prior recorded scheduling.";
    setProvider(
      makeMockProvider(
        buildConsolidatedResponseTextWithFollowUp(NO_SCHEME_WELL_FORMED, distinctFollowUpText),
      ),
    );

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.followUp.ok).toBe(true);
      expect(result.data.planGuidance.ok).toBe(true);
      if (result.data.planGuidance.ok) {
        expect(result.data.planGuidance.planGuidanceResult?.followUpSummary).toBe(distinctFollowUpText);
      }
    }
  });

  it("followUpSummary is omitted (not an error) when FOLLOW_UP_SUMMARY itself fails validation", async () => {
    // Under 20 chars triggers RESPONSE_EMPTY for the followUp section alone —
    // planGuidance's own blocks are unaffected and should still pass.
    setProvider(
      makeMockProvider(buildConsolidatedResponseTextWithFollowUp(NO_SCHEME_WELL_FORMED, "too short")),
    );

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.followUp.ok).toBe(false);
      expect(result.data.planGuidance.ok).toBe(true);
      if (result.data.planGuidance.ok) {
        expect(result.data.planGuidance.planGuidanceResult?.followUpSummary).toBeUndefined();
        expect(result.data.planGuidance.planGuidanceResult).toEqual({
          documentedProgression:
            "Timolol 0.5% documented from V1 2023-12-10; continued through V0 2024-06-15.",
          comfortingGuidance:
            "Patients documented with stable glaucoma monitoring are often reassured to learn regular follow-up detects change early.",
        });
      }
    }
  });

  it("a well-formed 3-block response with an exactly-matching govt scheme passes", async () => {
    // Override the current visit's diagnosis to match GOVT_SCHEMES[0] (cataract, H25/H26).
    vi.spyOn(ppmsClient, "getVisit").mockResolvedValue({
      ...FIXTURE_VISIT_CURRENT,
      diagnoses: [
        { description: "Age-related cataract", icd10Code: "H25.9", status: "ACTIVE", provisional: false, confirmed: true },
      ],
    });
    setProvider(makeMockProvider(buildConsolidatedResponseText(WITH_SCHEME_WELL_FORMED)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.planGuidance.ok).toBe(true);
      if (result.data.planGuidance.ok) {
        expect(result.data.planGuidance.planGuidanceResult?.govtScheme).toEqual({
          schemeName: WITH_SCHEME_ENTRY.schemeName,
          description: WITH_SCHEME_ENTRY.description,
          eligibilitySummary: WITH_SCHEME_ENTRY.eligibilitySummary,
          lastVerified: WITH_SCHEME_ENTRY.lastVerified,
        });
      }
    }
  });

  it("omitting the govt scheme block is always valid, even when a match exists", async () => {
    vi.spyOn(ppmsClient, "getVisit").mockResolvedValue({
      ...FIXTURE_VISIT_CURRENT,
      diagnoses: [
        { description: "Age-related cataract", icd10Code: "H25.9", status: "ACTIVE", provisional: false, confirmed: true },
      ],
    });
    // Model responds with only the 2 required blocks despite a match being available.
    setProvider(makeMockProvider(buildConsolidatedResponseText(NO_SCHEME_WELL_FORMED)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.planGuidance.ok).toBe(true);
      if (result.data.planGuidance.ok) {
        expect(result.data.planGuidance.planGuidanceResult?.govtScheme).toBeUndefined();
      }
    }
  });

  it("rejects a Govt Scheme block when no scheme was actually matched for this visit", async () => {
    // FIXTURE_VISIT_CURRENT's glaucoma diagnosis does not match any scheme,
    // but the model includes one anyway — must fail closed.
    setProvider(makeMockProvider(buildConsolidatedResponseText(SCHEME_BLOCK_WITHOUT_MATCH)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.planGuidance.ok).toBe(false);
      if (!result.data.planGuidance.ok) {
        expect(result.data.planGuidance.errorCode).toBe("PLAN_GUIDANCE_STRUCTURE_INVALID");
      }
    }
  });

  it("rejects a Govt Scheme block whose fields don't exactly match the matched entry", async () => {
    vi.spyOn(ppmsClient, "getVisit").mockResolvedValue({
      ...FIXTURE_VISIT_CURRENT,
      diagnoses: [
        { description: "Age-related cataract", icd10Code: "H25.9", status: "ACTIVE", provisional: false, confirmed: true },
      ],
    });
    setProvider(makeMockProvider(buildConsolidatedResponseText(SCHEME_WITH_WRONG_FIELD)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.planGuidance.ok).toBe(false);
      if (!result.data.planGuidance.ok) {
        expect(result.data.planGuidance.errorCode).toBe("PLAN_GUIDANCE_STRUCTURE_INVALID");
      }
    }
  });

  it("the fixed fallback sentences for both required blocks pass", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(FALLBACK_SENTENCES)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.planGuidance.ok).toBe(true);
  });

  it("imperative language is rejected as RESPONSE_UNSAFE", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(IMPERATIVE_LANGUAGE)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.planGuidance.ok).toBe(false);
      if (!result.data.planGuidance.ok) {
        expect(result.data.planGuidance.errorCode).toBe("RESPONSE_UNSAFE");
      }
    }
  });

  describe("prospective/future-tense treatment-escalation language is rejected as RESPONSE_UNSAFE", () => {
    it('rejects "the next step would be"', async () => {
      setProvider(makeMockProvider(buildConsolidatedResponseText(PROSPECTIVE_LANGUAGE_NEXT_STEP)));
      const result = await generate();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.planGuidance.ok).toBe(false);
        if (!result.data.planGuidance.ok) {
          expect(result.data.planGuidance.errorCode).toBe("RESPONSE_UNSAFE");
        }
      }
    });

    it('rejects "if X fails, try Y"', async () => {
      setProvider(makeMockProvider(buildConsolidatedResponseText(PROSPECTIVE_LANGUAGE_IF_FAILS)));
      const result = await generate();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.planGuidance.ok).toBe(false);
        if (!result.data.planGuidance.ok) {
          expect(result.data.planGuidance.errorCode).toBe("RESPONSE_UNSAFE");
        }
      }
    });
  });

  describe("malformed structure is rejected as PLAN_GUIDANCE_STRUCTURE_INVALID", () => {
    it("only one block present (Comforting Methods missing entirely)", async () => {
      setProvider(makeMockProvider(buildConsolidatedResponseText(MISSING_COMFORTING_BLOCK)));
      const result = await generate();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.planGuidance.ok).toBe(false);
        if (!result.data.planGuidance.ok) {
          expect(result.data.planGuidance.errorCode).toBe("PLAN_GUIDANCE_STRUCTURE_INVALID");
        }
      }
    });

    it("blocks out of order (Comforting Methods before Documented Progression)", async () => {
      setProvider(makeMockProvider(buildConsolidatedResponseText(BLOCKS_OUT_OF_ORDER)));
      const result = await generate();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.planGuidance.ok).toBe(false);
        if (!result.data.planGuidance.ok) {
          expect(result.data.planGuidance.errorCode).toBe("PLAN_GUIDANCE_STRUCTURE_INVALID");
        }
      }
    });

    it("unstructured free text with no block-shaped content at all", async () => {
      setProvider(makeMockProvider(buildConsolidatedResponseText(UNSTRUCTURED_FREE_TEXT)));
      const result = await generate();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.planGuidance.ok).toBe(false);
        if (!result.data.planGuidance.ok) {
          expect(result.data.planGuidance.errorCode).toBe("PLAN_GUIDANCE_STRUCTURE_INVALID");
        }
      }
    });
  });

  it("a malformed planGuidance section does not invalidate the other 11 sections", async () => {
    setProvider(makeMockProvider(buildConsolidatedResponseText(UNSTRUCTURED_FREE_TEXT)));

    const result = await generate();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.planGuidance.ok).toBe(false);
      expect(result.data.differentialDiagnosis.ok).toBe(true);
      expect(result.data.medications.ok).toBe(true);
      expect(result.data.suggestedQuestions.ok).toBe(true);
    }
  });
});
