// Clinical safety validator for AI responses.
//
// Three-layer check:
//   0. Pre-sanitisation: rewrites benign documentary phrases that incidentally
//      match a forbidden surface pattern (e.g. "I recommend the doctor review
//      this record" → "The record suggests the doctor review this record").
//      Only neutral documentary rewrites are allowed — this step must never
//      mask genuinely unsafe content.
//   1. Mechanical: empty, truncated, missing required sections
//   2. Clinical safety: pattern-based detection of prescriptive/diagnostic language
//
// A validation failure must discard the response entirely — the client renders
// an error and the doctor never sees the unvalidated content.
//
// This is the SECOND enforcement of the safety contract (the system prompt is
// the first). Both layers must always be present and neither can be bypassed.

import type { Capability } from "@/capabilities";

// ── Pre-sanitiser ─────────────────────────────────────────────────────────────
// Rewrites benign documentary phrases that incidentally match a forbidden
// surface pattern. Each substitution must be neutral — it must not change the
// clinical meaning of the sentence, only the grammatical person/voice.
// This is not a safety bypass: all rewrites produce language that would never
// trigger an unsafe-pattern match.

const SANITISE_RULES: { pattern: RegExp; replacement: string }[] = [
  // "I recommend the doctor review / consider / check…"  →  "The record suggests …"
  {
    pattern: /\bI recommend\s+(the\s+)?(doctor|clinician|physician|provider)\b/gi,
    replacement: "The record suggests the doctor",
  },
  // "I recommend reviewing this record / the findings / the timeline…"
  {
    pattern: /\bI recommend\s+reviewing\b/gi,
    replacement: "The record suggests reviewing",
  },
  // "I recommend noting…"
  {
    pattern: /\bI recommend\s+noting\b/gi,
    replacement: "It is worth noting",
  },
  // "I recommend referring to…"
  {
    pattern: /\bI recommend\s+referring\b/gi,
    replacement: "The record suggests referring",
  },
  // "I recommend confirming…"
  {
    pattern: /\bI recommend\s+confirming\b/gi,
    replacement: "The record suggests confirming",
  },
  // "I suggest …"  →  "The record suggests …"
  // Benign summarisation phrase — "I suggest the doctor review" is documentary, not prescriptive.
  {
    pattern: /\bI suggest\b/gi,
    replacement: "The record suggests",
  },
  // "I advise …"  →  "The record advises …"
  {
    pattern: /\bI advise\b/gi,
    replacement: "The record advises",
  },
  // "the diagnosis is" → "The documented diagnosis shows"
  // The AI uses this phrase in a documentary sense ("the diagnosis is glaucoma" = "the
  // record documents glaucoma"), but the hard-reject pattern cannot distinguish documentary
  // from prescriptive use.  The rewrite makes the intent unambiguously documentary.
  {
    pattern: /\bthe\s+diagnosis\s+is\b/gi,
    replacement: "The documented diagnosis shows",
  },
  // "the condition is" → "The documented condition is noted as"
  {
    pattern: /\bthe\s+condition\s+is\b/gi,
    replacement: "The documented condition is noted as",
  },
];

/**
 * Apply neutral documentary rewrites to remove benign surface-pattern matches
 * before the hard safety validator runs. Never masks genuinely unsafe content.
 */
export function sanitiseResponse(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SANITISE_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

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

// ── DIFFERENTIAL_DIAGNOSIS structural + confidence-vocabulary requirements ────
// The prompt (prompts/index.ts) locks the model to exactly this vocabulary and
// this list format. The validator enforces that lock structurally — it does not
// trust the model to have followed it. Per-item citation is NOT enforced here
// (product decision — see the per-item loop below for why).

// Confidence vocabulary is deliberately limited to two non-committal labels.
// "high" is never permitted — there is no cited-evidence tier that reaches it.
const DIFFERENTIAL_CONFIDENCE_LABELS = ["low consideration", "moderate consideration"];

const DIFFERENTIAL_HEADING = "## Possible Considerations for Review";

const DIFFERENTIAL_NO_EVIDENCE_SENTENCE =
  "The documented record does not contain sufficient findings to support any diagnostic considerations at this time.";

// Certainty language the confidence vocabulary above explicitly forbids.
// Separate from the generic UNSAFE_PATTERNS list because it's only unsafe in
// the context of a differential — "confirmed" is fine when NOTE_ASSISTANCE
// describes an already-documented diagnosis, but not here.
const DIFFERENTIAL_CERTAINTY_PATTERNS: RegExp[] = [
  /\bhigh(?:ly)?\s+(probability|likely|likelihood)\b/i,
  /\bconfirmed\s+diagnos/i,
  /\bcertain(ly)?\s+(has|is)\b/i,
  /\bdefinite(ly)?\s+diagnos/i,
];

// Matches one ranked-list item line, e.g.:
//   - **Anterior uveitis** — Moderate consideration (Source: V0 2024-06-15)
// Group 1: condition name. Group 2: confidence label text. Group 3: trailing
// parenthetical content (citation or otherwise) — captured but not validated.
const DIFFERENTIAL_ITEM_PATTERN =
  /^-\s*\*\*(.+?)\*\*\s*[-—]\s*([^(\n]+?)\s*(?:\(([^)]*)\))?\s*$/gm;

// Deliberately loose: matches ANY line that looks like it's trying to be a
// ranked-list item — "- **" or "* **" followed by anything — regardless of
// separator, confidence wording, or citation presence. Used only to COUNT
// candidate lines, never to extract data from them.
//
// Why this exists: DIFFERENTIAL_ITEM_PATTERN requires an exact shape. A line
// that drifts from it (wrong bullet character, en-dash instead of hyphen/em-dash,
// confidence label wrapped in its own parens, etc.) simply produces no match —
// it is invisible to items.length, not rejected by it. If even one OTHER line
// in the same response parses cleanly, items.length > 0 and the "list is
// empty" guard below never fires, so the drifted line — which may be uncited
// or use forbidden confidence language — would otherwise reach the doctor
// completely unchecked. Comparing the loose count to the strict count catches
// exactly this: any candidate line that failed to parse strictly.
const DIFFERENTIAL_LOOSE_CANDIDATE_PATTERN = /^[-*]\s*\*\*.+$/gm;

function validateDifferentialDiagnosis(sanitised: string): ValidationResult | null {
  // Returns null when structurally valid (caller proceeds to the shared warning
  // pass); returns a failing ValidationResult otherwise.

  // Certainty language is a hard reject regardless of list structure — the
  // vocabulary is locked to "low"/"moderate" and nothing may imply more.
  for (const pattern of DIFFERENTIAL_CERTAINTY_PATTERNS) {
    if (pattern.test(sanitised)) {
      return {
        ok: false,
        reason: "Contains diagnostic certainty language outside the permitted confidence vocabulary",
        code: "RESPONSE_UNSAFE",
      };
    }
  }

  if (!sanitised.includes(DIFFERENTIAL_HEADING)) {
    return {
      ok: false,
      reason: `Response missing required "${DIFFERENTIAL_HEADING}" section`,
      code: "DIFFERENTIAL_STRUCTURE_INVALID",
    };
  }

  const noEvidence = sanitised.includes(DIFFERENTIAL_NO_EVIDENCE_SENTENCE);
  const items = [...sanitised.matchAll(DIFFERENTIAL_ITEM_PATTERN)];
  const looseCandidates = [...sanitised.matchAll(DIFFERENTIAL_LOOSE_CANDIDATE_PATTERN)];

  // A loose candidate count higher than the strict parse count means at least
  // one list-item-shaped line failed to match the required format — reject
  // the whole response rather than silently validating only the subset that
  // happened to parse cleanly. Fail closed on ambiguity, not open.
  if (looseCandidates.length > items.length) {
    return {
      ok: false,
      reason: "Response contains a list item that does not match the required ranked-list format (check separator or confidence label)",
      code: "DIFFERENTIAL_STRUCTURE_INVALID",
    };
  }

  // No ranked items: only acceptable if the model used the exact fixed
  // insufficient-evidence sentence instead of inventing an unsupported one.
  if (items.length === 0) {
    if (noEvidence) return null;
    return {
      ok: false,
      reason:
        "Response is not a ranked list of considerations with confidence labels, " +
        "and does not contain the required insufficient-evidence sentence",
      code: "DIFFERENTIAL_STRUCTURE_INVALID",
    };
  }

  // A single well-formed item is a fully valid response — no minimum count.
  // Citation is deliberately NOT required here (product decision: always
  // attempt a best-effort list from whatever documented symptoms/history
  // exist, rather than refusing when evidence is thin). The prompt instructs
  // the model to disclose when a consideration isn't tied to a specific
  // documented finding rather than fabricating a citation, but that
  // disclosure is a prompt-level instruction, not independently verified
  // here — only structure and confidence vocabulary are still enforced.
  for (const match of items) {
    const [, name, confidenceRaw] = match;
    const label = confidenceRaw.trim().toLowerCase();

    if (!DIFFERENTIAL_CONFIDENCE_LABELS.includes(label)) {
      return {
        ok: false,
        reason: `Consideration "${name.trim()}" uses a confidence label outside "Low consideration" / "Moderate consideration"`,
        code: "DIFFERENTIAL_STRUCTURE_INVALID",
      };
    }
  }

  return null;
}

export type ValidationResult =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: string; code: string };

export function validateResponse(
  text: string,
  capability: Capability,
  stopReason?: string,
): ValidationResult {
  // 0. Pre-sanitise benign surface-pattern matches before hard checks
  const sanitised = sanitiseResponse(text);

  // 1. Empty or too short
  if (!sanitised || sanitised.trim().length < 20) {
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

  // 3. Unsafe pattern (hard reject — run against sanitised text)
  for (const { pattern, reason } of UNSAFE_PATTERNS) {
    if (pattern.test(sanitised)) {
      return { ok: false, reason, code: "RESPONSE_UNSAFE" };
    }
  }

  // 4. NOTE_ASSISTANCE: all four SOAP sections required
  if (capability === "NOTE_ASSISTANCE") {
    const missing = SOAP_SECTIONS.filter((s) => !sanitised.includes(s));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Note draft missing required sections: ${missing.join(", ")}`,
        code: "NOTE_INCOMPLETE",
      };
    }
  }

  // 4b. DIFFERENTIAL_DIAGNOSIS: ranked list with locked confidence vocabulary
  // (or the fixed insufficient-evidence sentence). Citation is not required.
  if (capability === "DIFFERENTIAL_DIAGNOSIS") {
    const result = validateDifferentialDiagnosis(sanitised);
    if (result) return result;
  }

  // 5. Warning patterns (soft — response allowed through with annotations)
  const warnings = WARNING_PATTERNS.filter(({ pattern }) => pattern.test(sanitised)).map(
    ({ warning }) => warning,
  );

  return { ok: true, warnings };
}
