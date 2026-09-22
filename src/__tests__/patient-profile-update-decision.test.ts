// decidePatientProfileUpdate — pure decision logic for whether CopilotApp
// should emit PLUGIN_PATIENT_PROFILE_UPDATE. Extracted from the React
// effect specifically so "fires exactly once per successful generation" is
// unit-testable without a DOM (this repo's vitest config uses
// environment: "node" — no React renderer available). Mirrors
// assessment-update-decision.test.ts, but exercises the three-independent-
// fields "omit rather than show broken" behavior specific to this decision.

import { describe, it, expect } from "vitest";
import { decidePatientProfileUpdate } from "@/lib/patient-profile-update";
import type { CopilotGenerateState, CopilotData } from "@/types/client";

const OK_SECTION = (text: string) => ({ ok: true as const, text, warnings: [] });
const FAIL_SECTION = { ok: false as const, errorCode: "RESPONSE_EMPTY", errorMessage: "empty" };

function makeDoneState(overrides: {
  requestId?: string;
  snapshotOk?: boolean;
  previousVisitsOk?: boolean;
  timelineOk?: boolean;
}): CopilotGenerateState {
  const snapshotOk = overrides.snapshotOk ?? true;
  const previousVisitsOk = overrides.previousVisitsOk ?? true;
  const timelineOk = overrides.timelineOk ?? true;

  const data: CopilotData = {
    snapshot: snapshotOk ? OK_SECTION("patient snapshot text") : FAIL_SECTION,
    previousVisits: previousVisitsOk ? OK_SECTION("previous visit summary text") : FAIL_SECTION,
    timeline: timelineOk ? OK_SECTION("timeline summary text") : FAIL_SECTION,
    attention: OK_SECTION("attention"),
    draftNote: OK_SECTION("draftNote"),
    followUp: OK_SECTION("followUp"),
    differentialDiagnosis: OK_SECTION("differentialDiagnosis"),
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

describe("decidePatientProfileUpdate", () => {
  it("does not send while still idle/loading", () => {
    expect(decidePatientProfileUpdate({ status: "idle" }, null)).toEqual({ send: false });
    expect(decidePatientProfileUpdate({ status: "loading" }, null)).toEqual({ send: false });
  });

  it("does not send on a top-level generation error", () => {
    const state: CopilotGenerateState = { status: "error", errorCode: "AI_UNAVAILABLE", errorMessage: "down" };
    expect(decidePatientProfileUpdate(state, null)).toEqual({ send: false });
  });

  it("sends all three fields when all three sections validate successfully", () => {
    const state = makeDoneState({ requestId: "req-1" });

    const decision = decidePatientProfileUpdate(state, null);

    expect(decision).toEqual({
      send: true,
      requestId: "req-1",
      patientSnapshot: "patient snapshot text",
      previousVisitSummary: "previous visit summary text",
      timelineSummary: "timeline summary text",
    });
  });

  it("omits (not errors) a field whose underlying section failed validation, while still sending the other two", () => {
    const state = makeDoneState({ requestId: "req-1", timelineOk: false });

    const decision = decidePatientProfileUpdate(state, null);

    expect(decision).toEqual({
      send: true,
      requestId: "req-1",
      patientSnapshot: "patient snapshot text",
      previousVisitSummary: "previous visit summary text",
      // timelineSummary intentionally absent — not undefined-valued, absent.
    });
    if (decision.send) {
      expect("timelineSummary" in decision).toBe(false);
    }
  });

  it("does not send at all when all three underlying sections failed validation", () => {
    const state = makeDoneState({
      requestId: "req-1",
      snapshotOk: false,
      previousVisitsOk: false,
      timelineOk: false,
    });

    expect(decidePatientProfileUpdate(state, null)).toEqual({ send: false });
  });

  it("does NOT re-send for the same requestId already sent — re-renders and tab switches don't re-fire", () => {
    const state = makeDoneState({ requestId: "req-1" });

    const decision = decidePatientProfileUpdate(state, "req-1");

    expect(decision).toEqual({ send: false });
  });

  it("DOES re-send after Regenerate produces a new requestId", () => {
    const state = makeDoneState({ requestId: "req-2" });

    const decision = decidePatientProfileUpdate(state, "req-1");

    expect(decision.send).toBe(true);
    if (decision.send) expect(decision.requestId).toBe("req-2");
  });

  it("does not send when the server response is missing a requestId (defensive — should never happen)", () => {
    const state = makeDoneState({});
    expect(decidePatientProfileUpdate(state, null)).toEqual({ send: false });
  });
});
