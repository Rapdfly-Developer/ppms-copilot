// Pure decision logic for whether CopilotApp should emit a
// PLUGIN_PATIENT_PROFILE_UPDATE postMessage — extracted so it can be
// unit-tested independently of the React effect that calls it, same
// rationale as lib/differential-update.ts and lib/plan-guidance-update.ts.
//
// This threads the three already-validated
// section texts (PATIENT_SNAPSHOT, PREVIOUS_VISIT_SUMMARY, LAST_VISIT_SUMMARY)
// out to PPMS Core, which renders them as sub-tabs within one Patient
// Profile card. Each field is independently optional — one failed section
// never blocks the other two ("omit rather than show broken", same as
// PlanGuidanceResult.followUpSummary). Only when ALL THREE failed for this
// generation is there nothing to report, and the decision is send: false.
//
// Must fire exactly once per successful generation:
//   - never repeatedly for a generation already sent (re-renders, tab
//     switches, a cache-hit re-selecting an already-sent result)
//   - again after Regenerate, since that produces a genuinely new generation
//
// Identity is the server's per-call GenerateMeta.requestId, not object
// reference — same as decideDifferentialUpdate/decidePlanGuidanceUpdate.

import type { CopilotGenerateState } from "@/types/client";

export type PatientProfileUpdateDecision =
  | {
      send: true;
      requestId: string;
      patientSnapshot?: string;
      previousVisitSummary?: string;
      lastVisitSummary?: string;
    }
  | { send: false };

export function decidePatientProfileUpdate(
  state: CopilotGenerateState,
  lastSentRequestId: string | null,
): PatientProfileUpdateDecision {
  if (state.status !== "done") return { send: false };

  const requestId = typeof state.meta?.requestId === "string" ? state.meta.requestId : null;
  if (!requestId || requestId === lastSentRequestId) return { send: false };

  const { snapshot, previousVisits, lastVisitSummary: lastVisit } = state.data;
  const patientSnapshot = snapshot.ok ? snapshot.text : undefined;
  const previousVisitSummary = previousVisits.ok ? previousVisits.text : undefined;
  const lastVisitSummary = lastVisit.ok ? lastVisit.text : undefined;

  if (!patientSnapshot && !previousVisitSummary && !lastVisitSummary) return { send: false };

  return {
    send: true,
    requestId,
    ...(patientSnapshot ? { patientSnapshot } : {}),
    ...(previousVisitSummary ? { previousVisitSummary } : {}),
    ...(lastVisitSummary ? { lastVisitSummary } : {}),
  };
}
