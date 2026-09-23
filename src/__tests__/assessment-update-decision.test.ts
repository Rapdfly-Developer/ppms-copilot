// decideAssessmentUpdate — pure decision logic for whether CopilotApp
// should emit PLUGIN_ASSESSMENT_UPDATE. Extracted from the React effect
// specifically so "fires exactly once per successful generation" is
// unit-testable without a DOM (this repo's vitest config uses
// environment: "node" — no React renderer available). Mirrors
// plan-guidance-update-decision.test.ts — same eager, pure-reuse pattern.

import { describe, it, expect } from "vitest";
import { decideAssessmentUpdate } from "@/lib/assessment-update";
import type { CopilotGenerateState, CopilotData } from "@/types/client";

const OK_SECTION = (text: string) => ({ ok: true as const, text, warnings: [] });
const FAIL_SECTION = { ok: false as const, errorCode: "RESPONSE_EMPTY", errorMessage: "empty" };

function makeDoneState(overrides: {
  requestId?: string;
  assessmentOk: boolean;
  assessmentText?: string;
}): CopilotGenerateState {
  const data: CopilotData = {
    diagnosisComparison: { ok: false, errorCode: "RESPONSE_EMPTY", errorMessage: "empty" },
    timeline: OK_SECTION("timeline"),
    attention: OK_SECTION("attention"),
    draftNote: OK_SECTION("draftNote"),
    followUp: OK_SECTION("followUp"),
    differentialDiagnosis: OK_SECTION("differentialDiagnosis"),
    medications: OK_SECTION("medications"),
    investigations: OK_SECTION("investigations"),
    assessmentContext: overrides.assessmentOk
      ? OK_SECTION(overrides.assessmentText ?? "## Current Diagnoses\nNo diagnoses documented.")
      : FAIL_SECTION,
    suggestedQuestions: OK_SECTION("suggestedQuestions"),
    planGuidance: OK_SECTION("planGuidance"),
    investigationGuidance: OK_SECTION("investigationGuidance"),
  };

  return {
    status: "done",
    data,
    meta: overrides.requestId ? { requestId: overrides.requestId } : {},
  };
}

describe("decideAssessmentUpdate", () => {
  it("does not send while still idle/loading", () => {
    expect(decideAssessmentUpdate({ status: "idle" }, null)).toEqual({ send: false });
    expect(decideAssessmentUpdate({ status: "loading" }, null)).toEqual({ send: false });
  });

  it("does not send on a top-level generation error", () => {
    const state: CopilotGenerateState = { status: "error", errorCode: "AI_UNAVAILABLE", errorMessage: "down" };
    expect(decideAssessmentUpdate(state, null)).toEqual({ send: false });
  });

  it("does not send when assessmentContext itself failed validation, even though generation overall succeeded", () => {
    const state = makeDoneState({ requestId: "req-1", assessmentOk: false });
    expect(decideAssessmentUpdate(state, null)).toEqual({ send: false });
  });

  it("sends on the first successful generation, carrying the section text and requestId", () => {
    const state = makeDoneState({ requestId: "req-1", assessmentOk: true, assessmentText: "## Current Diagnoses\nPrimary open-angle glaucoma." });

    const decision = decideAssessmentUpdate(state, null);

    expect(decision).toEqual({
      send: true,
      assessmentContext: "## Current Diagnoses\nPrimary open-angle glaucoma.",
      requestId: "req-1",
    });
  });

  it("does NOT re-send for the same requestId already sent — re-renders and tab switches don't re-fire", () => {
    const state = makeDoneState({ requestId: "req-1", assessmentOk: true });

    const decision = decideAssessmentUpdate(state, "req-1");

    expect(decision).toEqual({ send: false });
  });

  it("DOES re-send after Regenerate produces a new requestId", () => {
    const state = makeDoneState({ requestId: "req-2", assessmentOk: true, assessmentText: "updated" });

    const decision = decideAssessmentUpdate(state, "req-1");

    expect(decision).toEqual({ send: true, assessmentContext: "updated", requestId: "req-2" });
  });

  it("does not send when the server response is missing a requestId (defensive — should never happen)", () => {
    const state = makeDoneState({ assessmentOk: true });
    expect(decideAssessmentUpdate(state, null)).toEqual({ send: false });
  });
});
