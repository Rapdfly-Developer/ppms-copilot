// Clinical safety validator for AI responses.
//
// Two-layer check:
//   1. Mechanical: empty, truncated, missing required sections
//   2. Clinical safety: pattern-based detection of prescriptive/diagnostic language
//
// A validation failure must discard the response entirely — the client renders
// an error and the doctor never sees the unvalidated content.
//
// This is the SECOND enforcement of the safety contract (the system prompt is
// the first). Both layers must always be present and neither can be bypassed.

import type { Capability } from "@/capabilities";

// Hard reject: any match discards the entire response
const UNSAFE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bI recommend\b/i, reason: "Contains prescriptive recommendation language" },
  {
    pattern: /\byou should\s+(start|stop|continue|increase|decrease|change|switch|take|use|try|begin)\b/i,
    reason: "Contains prescriptive instruction language",
  },
  {
    pattern: /\bI\s+(diagnose|prescribe|advise|recommend|suggest)\b/i,
    reason: "Contains first-person prescriptive or diagnostic language",
  },
  {
    pattern: /\bthe\s+(diagnosis|condition)\s+is\b/i,
    reason: "Contains definitive diagnostic language",
  },
  { pattern: /\bdefinitely\s+has\b/i, reason: "Contains definitive diagnostic language" },
  {
    pattern: /\bchange\s+(the|their|this)\s+(dose|dosage|medication|drug|treatment)\s+to\b/i,
    reason: "Contains medication management language",
  },
  {
    pattern: /\b(start|initiate|begin)\s+treatment\s+with\b/i,
    reason: "Contains prescriptive treatment language",
  },
  {
    pattern: /\badd\s+\w+(\s+\w+)?\s+to\s+(the|their)\s+(regimen|medications|treatment)\b/i,
    reason: "Contains prescriptive medication language",
  },
];

// Soft warn: matches annotate the response but do not discard it
const WARNING_PATTERNS: { pattern: RegExp; warning: string }[] = [
  {
    pattern: /\blikely\s+(indicates?|suggests?|represents?)\b/i,
    warning: "Contains speculative clinical language — please review",
  },
  {
    pattern: /\bprobably\s+(has|indicates?|represents?|means)\b/i,
    warning: "Contains speculative language — please review",
  },
  {
    pattern: /\bconsider\s+(starting|adding|changing|switching|using|trying)\b/i,
    warning: "Contains suggestion language — review carefully before acting",
  },
  {
    pattern: /\bmay\s+(indicate|suggest|represent|benefit\s+from)\b/i,
    warning: "Contains speculative language — please review",
  },
];

// NOTE_ASSISTANCE requires all four SOAP sections
const SOAP_SECTIONS = ["Subjective:", "Objective:", "Assessment:", "Plan:"];

export type ValidationResult =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: string; code: string };

export function validateResponse(
  text: string,
  capability: Capability,
  stopReason?: string,
): ValidationResult {
  // 1. Empty or too short
  if (!text || text.trim().length < 20) {
    return { ok: false, reason: "Response is empty or too short", code: "RESPONSE_EMPTY" };
  }

  // 2. Truncated at token limit
  if (stopReason === "max_tokens") {
    return {
      ok: false,
      reason: "Response was truncated — please try again",
      code: "RESPONSE_TRUNCATED",
    };
  }

  // 3. Unsafe pattern (hard reject)
  for (const { pattern, reason } of UNSAFE_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason, code: "RESPONSE_UNSAFE" };
    }
  }

  // 4. NOTE_ASSISTANCE: all four SOAP sections required
  if (capability === "NOTE_ASSISTANCE") {
    const missing = SOAP_SECTIONS.filter((s) => !text.includes(s));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Note draft missing required sections: ${missing.join(", ")}`,
        code: "NOTE_INCOMPLETE",
      };
    }
  }

  // 5. Warning patterns (soft — response allowed through with annotations)
  const warnings = WARNING_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ warning }) => warning,
  );

  return { ok: true, warnings };
}
