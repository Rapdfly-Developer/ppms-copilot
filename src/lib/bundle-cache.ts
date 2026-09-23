// Per-visit cache of the completed consolidated bundle, kept in the Copilot
// iframe's own sessionStorage so a page reload (which re-sends PPMS_INIT for
// the same visit) reuses the result instead of re-running the AI call.
//
//   - Keyed by visitId; the "v1" segment is bumped whenever CopilotData's
//     shape changes so an older cached entry is ignored, not misread.
//   - Holds only the generated section outcomes and meta — never the token.
//   - sessionStorage is per-tab and cleared when the tab closes.
//   - Every access is wrapped: storage can be unavailable (privacy mode,
//     blocked third-party storage in an iframe) or full, and the Copilot must
//     then behave exactly as it did without the cache.
//   - Regenerate calls clearCachedBundle() before fetching fresh.

import type { CopilotData, CopilotGenerateState } from "@/types/client";

type DoneState = CopilotGenerateState & { status: "done" };

const KEY_PREFIX = "ppms-copilot:bundle:v1:";

const SECTION_KEYS: Array<keyof CopilotData> = [
  "timeline",
  "attention",
  "draftNote",
  "followUp",
  "differentialDiagnosis",
  "medications",
  "investigations",
  "assessmentContext",
  "suggestedQuestions",
  "planGuidance",
  "investigationGuidance",
  "diagnosisComparison",
];

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isDoneState(value: unknown): value is DoneState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.status !== "done" || !v.data || typeof v.data !== "object") return false;
  if (!v.meta || typeof v.meta !== "object") return false;
  const data = v.data as Record<string, unknown>;
  return SECTION_KEYS.every((key) => {
    const section = data[key] as Record<string, unknown> | undefined;
    return !!section && typeof section === "object" && typeof section.ok === "boolean";
  });
}

export function readCachedBundle(visitId: string, storage = defaultStorage()): DoneState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY_PREFIX + visitId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isDoneState(parsed)) return parsed;
    storage.removeItem(KEY_PREFIX + visitId);
    return null;
  } catch {
    return null;
  }
}

export function writeCachedBundle(visitId: string, state: DoneState, storage = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(KEY_PREFIX + visitId, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage blocked — the in-memory cache still applies.
  }
}

export function clearCachedBundle(visitId: string, storage = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(KEY_PREFIX + visitId);
  } catch {
    // Storage blocked — nothing cached to clear.
  }
}
