// Pure decision logic for whether CopilotApp should emit a
// PLUGIN_INVESTIGATION_GUIDANCE_UPDATE postMessage — extracted so it can be
// unit-tested independently of the React effect that calls it, same
// rationale as lib/plan-guidance-update.ts, which this mirrors exactly.
//
// Must fire exactly once per successful generation:
//   - never when investigationGuidance failed validation (section.ok === false)
//   - never when investigationGuidanceResult is absent despite ok:true
//     (defensive — should never happen, since validateInvestigationGuidance
//     always pairs ok:true with a result, but this decision function fails
//     closed rather than assuming that invariant holds)
//   - never repeatedly for a generation already sent (re-renders, tab
//     switches, a cache-hit re-selecting an already-sent result)
//   - again after Regenerate, since that produces a genuinely new generation
//
// Identity is the server's per-call GenerateMeta.requestId, not object
// reference — same as decidePlanGuidanceUpdate.

import type { CopilotGenerateState, InvestigationGuidanceResult } from "@/types/client";

export type InvestigationGuidanceUpdateDecision =
  | { send: true; result: InvestigationGuidanceResult; requestId: string }
  | { send: false };

export function decideInvestigationGuidanceUpdate(
  state: CopilotGenerateState,
  lastSentRequestId: string | null,
): InvestigationGuidanceUpdateDecision {
  if (state.status !== "done") return { send: false };

  const requestId = typeof state.meta?.requestId === "string" ? state.meta.requestId : null;
  if (!requestId || requestId === lastSentRequestId) return { send: false };

  const section = state.data.investigationGuidance;
  if (!section.ok || !section.investigationGuidanceResult) return { send: false };

  return { send: true, result: section.investigationGuidanceResult, requestId };
}
