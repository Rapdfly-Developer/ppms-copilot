// decideInvestigationGuidanceUpdate — pure decision logic for whether
// CopilotApp should emit PLUGIN_INVESTIGATION_GUIDANCE_UPDATE. Extracted from
// the React effect specifically so "fires exactly once per successful
// generation" is unit-testable without a DOM (this repo's vitest config uses
// environment: "node" — no React renderer available). Mirrors
// plan-guidance-update-decision.test.ts exactly — same eager pattern.

import { describe, it, expect } from "vitest";
import { decideInvestigationGuidanceUpdate } from "@/lib/investigation-guidance-update";
import type { CopilotGenerateState, CopilotData, InvestigationGuidanceResult } from "@/types/client";

const OK_SECTION = (text: string) => ({ ok: true as const, text, warnings: [] });

function makeDoneState(overrides: {
  requestId?: string;
  investigationGuidanceOk: boolean;
  result?: InvestigationGuidanceResult;
  missingResult?: boolean;
}): CopilotGenerateState {
  const data: CopilotData = {
    snapshot: OK_SECTION("snapshot"),
    previousVisits: OK_SECTION("previousVisits"),
    timeline: OK_SECTION("timeline"),
    attention: OK_SECTION("attention"),
    draftNote: OK_SECTION("draftNote"),
    followUp: OK_SECTION("followUp"),
    differentialDiagnosis: OK_SECTION("differentialDiagnosis"),
    medications: OK_SECTION("medications"),
    investigations: OK_SECTION("investigations"),
    assessmentContext: OK_SECTION("assessmentContext"),
    suggestedQuestions: OK_SECTION("suggestedQuestions"),
    planGuidance: OK_SECTION("planGuidance"),
    investigationGuidance: overrides.investigationGuidanceOk
      ? {
          ok: true,
          text: "investigation guidance",
          warnings: [],
          ...(overrides.missingResult ? {} : { investigationGuidanceResult: overrides.result }),
        }
      : { ok: false, errorCode: "INVESTIGATION_GUIDANCE_STRUCTURE_INVALID", errorMessage: "bad format" },
  };

  return {
    status: "done",
    data,
    meta: overrides.requestId ? { requestId: overrides.requestId } : {},
  };
}

const SAMPLE_RESULT: InvestigationGuidanceResult = {
  suggestedInvestigations: [
    {
      name: "Optical Coherence Tomography (OCT)",
      rationale: "Documented gradual central vision distortion is consistent with a clinical picture where OCT is commonly used to assess retinal layer changes.",
      confidence: "Moderate",
      source: "V0 2024-06-15",
    },
  ],
};

const SAMPLE_RESULT_WITH_SUMMARY: InvestigationGuidanceResult = {
  ...SAMPLE_RESULT,
  investigationsSummary: "- **OCT** (imaging) — Status: completed — Ordered: V1 2024-01-15",
};

describe("decideInvestigationGuidanceUpdate", () => {
  it("does not send while still idle/loading", () => {
    expect(decideInvestigationGuidanceUpdate({ status: "idle" }, null)).toEqual({ send: false });
    expect(decideInvestigationGuidanceUpdate({ status: "loading" }, null)).toEqual({ send: false });
  });

  it("does not send on a top-level generation error", () => {
    const state: CopilotGenerateState = { status: "error", errorCode: "AI_UNAVAILABLE", errorMessage: "down" };
    expect(decideInvestigationGuidanceUpdate(state, null)).toEqual({ send: false });
  });

  it("does not send when investigationGuidance itself failed validation, even though generation overall succeeded", () => {
    const state = makeDoneState({ requestId: "req-1", investigationGuidanceOk: false });
    expect(decideInvestigationGuidanceUpdate(state, null)).toEqual({ send: false });
  });

  it("does not send when investigationGuidanceResult is absent despite ok:true (defensive — should never happen)", () => {
    const state = makeDoneState({ requestId: "req-1", investigationGuidanceOk: true, missingResult: true });
    expect(decideInvestigationGuidanceUpdate(state, null)).toEqual({ send: false });
  });

  it("sends on the first successful generation, carrying the structured result and requestId", () => {
    const state = makeDoneState({ requestId: "req-1", investigationGuidanceOk: true, result: SAMPLE_RESULT });

    const decision = decideInvestigationGuidanceUpdate(state, null);

    expect(decision).toEqual({ send: true, result: SAMPLE_RESULT, requestId: "req-1" });
  });

  it("sends a result including investigationsSummary when threading succeeded", () => {
    const state = makeDoneState({
      requestId: "req-1",
      investigationGuidanceOk: true,
      result: SAMPLE_RESULT_WITH_SUMMARY,
    });

    const decision = decideInvestigationGuidanceUpdate(state, null);

    expect(decision).toEqual({ send: true, result: SAMPLE_RESULT_WITH_SUMMARY, requestId: "req-1" });
  });

  it("does NOT re-send for the same requestId already sent — re-renders and tab switches don't re-fire", () => {
    const state = makeDoneState({ requestId: "req-1", investigationGuidanceOk: true, result: SAMPLE_RESULT });

    const decision = decideInvestigationGuidanceUpdate(state, "req-1");

    expect(decision).toEqual({ send: false });
  });

  it("DOES re-send after Regenerate produces a new requestId", () => {
    const state = makeDoneState({ requestId: "req-2", investigationGuidanceOk: true, result: SAMPLE_RESULT });

    const decision = decideInvestigationGuidanceUpdate(state, "req-1");

    expect(decision).toEqual({ send: true, result: SAMPLE_RESULT, requestId: "req-2" });
  });

  it("does not send when the server response is missing a requestId (defensive — should never happen)", () => {
    const state = makeDoneState({ investigationGuidanceOk: true, result: SAMPLE_RESULT });
    expect(decideInvestigationGuidanceUpdate(state, null)).toEqual({ send: false });
  });
});
