// Pure decision logic for whether CopilotApp should emit a
// PLUGIN_DIFFERENTIAL_UPDATE postMessage — extracted so it can be unit-tested
// independently of the React effect that calls it, same rationale as
// lib/postmessage-validator.ts for the inbound PPMS_INIT message.
//
// Must fire exactly once per successful generation:
//   - never when differentialDiagnosis failed validation (state.data.differentialDiagnosis.ok === false)
//   - never repeatedly for a generation already sent (re-renders, tab switches,
//     a cache-hit re-selecting an already-sent result)
//   - again after Regenerate, since that produces a genuinely new generation
//
// Identity is the server's per-call GenerateMeta.requestId, not object
// reference — a cache hit within the same mount reuses the same requestId,
// so re-selecting cached data never re-fires this.

import type { CopilotGenerateState, DifferentialDiagnosisItem } from "@/types/client";

export type DifferentialUpdateDecision =
  | { send: true; items: DifferentialDiagnosisItem[]; requestId: string }
  | { send: false };

export function decideDifferentialUpdate(
  state: CopilotGenerateState,
  lastSentRequestId: string | null,
): DifferentialUpdateDecision {
  if (state.status !== "done") return { send: false };

  const requestId = typeof state.meta?.requestId === "string" ? state.meta.requestId : null;
  if (!requestId || requestId === lastSentRequestId) return { send: false };

  const section = state.data.differentialDiagnosis;
  if (!section.ok) return { send: false };

  return { send: true, items: section.differentialDiagnosisItems ?? [], requestId };
}
