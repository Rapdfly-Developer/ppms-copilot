// decidePlanGuidanceUpdate — pure decision logic for whether CopilotApp
// should emit PLUGIN_PLAN_GUIDANCE_UPDATE. Extracted from the React effect
// specifically so "fires exactly once per successful generation" is
// unit-testable without a DOM (this repo's vitest config uses
// environment: "node" — no React renderer available). Mirrors
// differential-update-decision.test.ts exactly — same eager pattern.

import { describe, it, expect } from "vitest";
import { decidePlanGuidanceUpdate } from "@/lib/plan-guidance-update";
import type { CopilotGenerateState, CopilotData, PlanGuidanceResult } from "@/types/client";

const OK_SECTION = (text: string) => ({ ok: true as const, text, warnings: [] });

function makeDoneState(overrides: {
  requestId?: string;
  planGuidanceOk: boolean;
  result?: PlanGuidanceResult;
  missingResult?: boolean;
}): CopilotGenerateState {
  const data: CopilotData = {
    diagnosisComparison: { ok: false, errorCode: "RESPONSE_EMPTY", errorMessage: "empty" },
    lastVisitSummary: { ok: false, errorCode: "RESPONSE_EMPTY", errorMessage: "empty" },
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
    planGuidance: overrides.planGuidanceOk
      ? {
          ok: true,
          text: "plan guidance",
          warnings: [],
          ...(overrides.missingResult ? {} : { planGuidanceResult: overrides.result }),
        }
      : { ok: false, errorCode: "PLAN_GUIDANCE_STRUCTURE_INVALID", errorMessage: "bad format" },
    investigationGuidance: OK_SECTION("investigationGuidance"),
  };

  return {
    status: "done",
    data,
    meta: overrides.requestId ? { requestId: overrides.requestId } : {},
  };
}

const SAMPLE_RESULT: PlanGuidanceResult = {
  documentedProgression: "Timolol documented from V1 2023-12-10; continued through V0 2024-06-15.",
  comfortingGuidance: "Patients documented with stable glaucoma monitoring are often reassured.",
};

const SAMPLE_RESULT_WITH_SCHEME: PlanGuidanceResult = {
  ...SAMPLE_RESULT,
  govtScheme: {
    schemeName: "Ayushman Bharat – Pradhan Mantri Jan Arogya Yojana (AB-PMJAY)",
    description: "National health insurance scheme covering secondary and tertiary hospitalisation.",
    eligibilitySummary: "Families listed under SECC 2011 deprivation criteria.",
    lastVerified: "2026-09-21",
  },
};

describe("decidePlanGuidanceUpdate", () => {
  it("does not send while still idle/loading", () => {
    expect(decidePlanGuidanceUpdate({ status: "idle" }, null)).toEqual({ send: false });
    expect(decidePlanGuidanceUpdate({ status: "loading" }, null)).toEqual({ send: false });
  });

  it("does not send on a top-level generation error", () => {
    const state: CopilotGenerateState = { status: "error", errorCode: "AI_UNAVAILABLE", errorMessage: "down" };
    expect(decidePlanGuidanceUpdate(state, null)).toEqual({ send: false });
  });

  it("does not send when planGuidance itself failed validation, even though generation overall succeeded", () => {
    const state = makeDoneState({ requestId: "req-1", planGuidanceOk: false });
    expect(decidePlanGuidanceUpdate(state, null)).toEqual({ send: false });
  });

  it("does not send when planGuidanceResult is absent despite ok:true (defensive — should never happen)", () => {
    const state = makeDoneState({ requestId: "req-1", planGuidanceOk: true, missingResult: true });
    expect(decidePlanGuidanceUpdate(state, null)).toEqual({ send: false });
  });

  it("sends on the first successful generation, carrying the structured result and requestId", () => {
    const state = makeDoneState({ requestId: "req-1", planGuidanceOk: true, result: SAMPLE_RESULT });

    const decision = decidePlanGuidanceUpdate(state, null);

    expect(decision).toEqual({ send: true, result: SAMPLE_RESULT, requestId: "req-1" });
  });

  it("sends a result including govtScheme when a confident match was cited", () => {
    const state = makeDoneState({ requestId: "req-1", planGuidanceOk: true, result: SAMPLE_RESULT_WITH_SCHEME });

    const decision = decidePlanGuidanceUpdate(state, null);

    expect(decision).toEqual({ send: true, result: SAMPLE_RESULT_WITH_SCHEME, requestId: "req-1" });
  });

  it("does NOT re-send for the same requestId already sent — re-renders and tab switches don't re-fire", () => {
    const state = makeDoneState({ requestId: "req-1", planGuidanceOk: true, result: SAMPLE_RESULT });

    // Simulates calling the effect again with the same state object (a
    // re-render) after already having sent "req-1".
    const decision = decidePlanGuidanceUpdate(state, "req-1");

    expect(decision).toEqual({ send: false });
  });

  it("DOES re-send after Regenerate produces a new requestId", () => {
    const state = makeDoneState({ requestId: "req-2", planGuidanceOk: true, result: SAMPLE_RESULT });

    const decision = decidePlanGuidanceUpdate(state, "req-1");

    expect(decision).toEqual({ send: true, result: SAMPLE_RESULT, requestId: "req-2" });
  });

  it("does not send when the server response is missing a requestId (defensive — should never happen)", () => {
    const state = makeDoneState({ planGuidanceOk: true, result: SAMPLE_RESULT });
    expect(decidePlanGuidanceUpdate(state, null)).toEqual({ send: false });
  });
});
