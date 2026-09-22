// Pure decision logic for whether CopilotApp should emit a
// PLUGIN_PLAN_GUIDANCE_UPDATE postMessage — extracted so it can be
// unit-tested independently of the React effect that calls it, same
// rationale as lib/differential-update.ts.
//
// Must fire exactly once per successful generation:
//   - never when planGuidance failed validation (state.data.planGuidance.ok === false)
//   - never when planGuidanceResult is absent despite ok:true (defensive —
//     should never happen, since validatePlanGuidance always pairs ok:true
//     with a result, but this decision function fails closed rather than
//     assuming that invariant holds)
//   - never repeatedly for a generation already sent (re-renders, tab switches,
//     a cache-hit re-selecting an already-sent result)
//   - again after Regenerate, since that produces a genuinely new generation
//
// Identity is the server's per-call GenerateMeta.requestId, not object
// reference — same as decideDifferentialUpdate.

import type { CopilotGenerateState, PlanGuidanceResult } from "@/types/client";

export type PlanGuidanceUpdateDecision =
  | { send: true; result: PlanGuidanceResult; requestId: string }
  | { send: false };

export function decidePlanGuidanceUpdate(
  state: CopilotGenerateState,
  lastSentRequestId: string | null,
): PlanGuidanceUpdateDecision {
  if (state.status !== "done") return { send: false };

  const requestId = typeof state.meta?.requestId === "string" ? state.meta.requestId : null;
  if (!requestId || requestId === lastSentRequestId) return { send: false };

  const section = state.data.planGuidance;
  if (!section.ok || !section.planGuidanceResult) return { send: false };

  return { send: true, result: section.planGuidanceResult, requestId };
}
