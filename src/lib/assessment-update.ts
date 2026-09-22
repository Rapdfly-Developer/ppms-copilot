// Pure decision logic for whether CopilotApp should emit a
// PLUGIN_ASSESSMENT_UPDATE postMessage — extracted so it can be unit-tested
// independently of the React effect that calls it, same rationale as
// lib/differential-update.ts and lib/plan-guidance-update.ts.
//
// Pure reuse, no new AI call: this just threads the already-validated
// ASSESSMENT_CONTEXT section text out to PPMS Core. Must fire exactly once
// per successful generation:
//   - never when assessmentContext failed validation (section.ok === false)
//   - never repeatedly for a generation already sent (re-renders, tab
//     switches, a cache-hit re-selecting an already-sent result)
//   - again after Regenerate, since that produces a genuinely new generation
//
// Identity is the server's per-call GenerateMeta.requestId, not object
// reference — same as decideDifferentialUpdate/decidePlanGuidanceUpdate.

import type { CopilotGenerateState, DiagnosisComparisonResult } from "@/types/client";

export type AssessmentUpdateDecision =
  | { send: true; assessmentContext: string; diagnosisComparison?: DiagnosisComparisonResult; requestId: string }
  | { send: false };

export function decideAssessmentUpdate(
  state: CopilotGenerateState,
  lastSentRequestId: string | null,
): AssessmentUpdateDecision {
  if (state.status !== "done") return { send: false };

  const requestId = typeof state.meta?.requestId === "string" ? state.meta.requestId : null;
  if (!requestId || requestId === lastSentRequestId) return { send: false };

  const section = state.data.assessmentContext;
  if (!section.ok) return { send: false };

  const comparison = state.data.diagnosisComparison;
  return { send: true, assessmentContext: section.text, requestId,
    ...(comparison?.ok && comparison.diagnosisComparisonResult ? { diagnosisComparison: comparison.diagnosisComparisonResult } : {}),
  };
}
