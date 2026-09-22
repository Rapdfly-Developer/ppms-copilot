// decideDifferentialUpdate — pure decision logic for whether CopilotApp
// should emit PLUGIN_DIFFERENTIAL_UPDATE. Extracted from the React effect
// specifically so "fires exactly once per successful generation" is
// unit-testable without a DOM (this repo's vitest config uses
// environment: "node" — no React renderer available).

import { describe, it, expect } from "vitest";
import { decideDifferentialUpdate } from "@/lib/differential-update";
import type { CopilotGenerateState, CopilotData, DifferentialDiagnosisItem } from "@/types/client";

const OK_SECTION = (text: string) => ({ ok: true as const, text, warnings: [] });

function makeDoneState(overrides: {
  requestId?: string;
  differentialOk: boolean;
  items?: DifferentialDiagnosisItem[];
}): CopilotGenerateState {
  const data: CopilotData = {
    snapshot: OK_SECTION("snapshot"),
    previousVisits: OK_SECTION("previousVisits"),
    timeline: OK_SECTION("timeline"),
    attention: OK_SECTION("attention"),
    draftNote: OK_SECTION("draftNote"),
    followUp: OK_SECTION("followUp"),
    differentialDiagnosis: overrides.differentialOk
      ? { ok: true, text: "differential", warnings: [], differentialDiagnosisItems: overrides.items }
      : { ok: false, errorCode: "DIFFERENTIAL_STRUCTURE_INVALID", errorMessage: "bad format" },
    medications: OK_SECTION("medications"),
    investigations: OK_SECTION("investigations"),
    assessmentContext: OK_SECTION("assessmentContext"),
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

const SAMPLE_ITEMS: DifferentialDiagnosisItem[] = [
  { name: "Anterior uveitis", confidence: "Moderate", source: "V0 2024-06-15" },
];

describe("decideDifferentialUpdate", () => {
  it("does not send while still idle/loading", () => {
    expect(decideDifferentialUpdate({ status: "idle" }, null)).toEqual({ send: false });
    expect(decideDifferentialUpdate({ status: "loading" }, null)).toEqual({ send: false });
  });

  it("does not send on a top-level generation error", () => {
    const state: CopilotGenerateState = { status: "error", errorCode: "AI_UNAVAILABLE", errorMessage: "down" };
    expect(decideDifferentialUpdate(state, null)).toEqual({ send: false });
  });

  it("does not send when differentialDiagnosis itself failed validation, even though generation overall succeeded", () => {
    const state = makeDoneState({ requestId: "req-1", differentialOk: false });
    expect(decideDifferentialUpdate(state, null)).toEqual({ send: false });
  });

  it("sends on the first successful generation, carrying the structured items and requestId", () => {
    const state = makeDoneState({ requestId: "req-1", differentialOk: true, items: SAMPLE_ITEMS });

    const decision = decideDifferentialUpdate(state, null);

    expect(decision).toEqual({ send: true, items: SAMPLE_ITEMS, requestId: "req-1" });
  });

  it("sends an empty items array as-is (e.g. insufficient-evidence case) — not skipped", () => {
    const state = makeDoneState({ requestId: "req-1", differentialOk: true, items: [] });

    const decision = decideDifferentialUpdate(state, null);

    expect(decision).toEqual({ send: true, items: [], requestId: "req-1" });
  });

  it("does NOT re-send for the same requestId already sent — re-renders and tab switches don't re-fire", () => {
    const state = makeDoneState({ requestId: "req-1", differentialOk: true, items: SAMPLE_ITEMS });

    // Simulates calling the effect again with the same state object (a
    // re-render) after already having sent "req-1".
    const decision = decideDifferentialUpdate(state, "req-1");

    expect(decision).toEqual({ send: false });
  });

  it("DOES re-send after Regenerate produces a new requestId", () => {
    const state = makeDoneState({ requestId: "req-2", differentialOk: true, items: SAMPLE_ITEMS });

    const decision = decideDifferentialUpdate(state, "req-1");

    expect(decision).toEqual({ send: true, items: SAMPLE_ITEMS, requestId: "req-2" });
  });

  it("does not send when the server response is missing a requestId (defensive — should never happen)", () => {
    const state = makeDoneState({ differentialOk: true, items: SAMPLE_ITEMS });
    expect(decideDifferentialUpdate(state, null)).toEqual({ send: false });
  });
});
