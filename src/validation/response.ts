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
// The prompt (prompts/index.ts) locks the model to a fixed multi-line block
// format — name, reason, confidence, optional source — one block per
// consideration, blank line between blocks. The validator enforces that lock
// field-by-field per block; it does not trust the model to have followed it.
// Per-item citation is NOT required (product decision — see parseConsiderationBlock).
//
// This replaces an earlier single-line "- **Name** — confidence (citation)"
// regex format, which needed hardening twice against realistic model drift
// (a citation-bypass bug, then dropped/split honesty-disclosure punctuation).
// The multi-line block format sidesteps both failure classes: each field is
// its own line, so there is no shared trailing clause for drift to hide in.

// Confidence vocabulary is deliberately limited to two non-committal labels.
// "high" is never permitted — there is no cited-evidence tier that reaches it.
const DIFFERENTIAL_CONFIDENCE_LABELS = ["low", "moderate"];

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

// Isolates the considerations list from the rest of the response. No leading
// heading is required — the prompt used to require a literal "## Possible
// Considerations for Review" line, but openai/gpt-oss-120b reliably omitted
// it (consistently reproduced live: well-formed blocks, no heading at all),
// especially once this text is embedded as one JSON string value in the
// consolidated response rather than a standalone reply. The heading was
// never actually load-bearing for parsing — blocks can be isolated starting
// from the beginning of the text just as well — so the prompt no longer asks
// for one. If a leading "## ..." line is present anyway (old habit, or
// drift, since other sections in the same consolidated response DO use "##"
// headers), skip past it rather than let it corrupt block 1's parse.
// Whatever's left is bounded by the next "## " heading (e.g. Documentation
// Gaps) or a "---" line, whichever comes first — same boundary logic as
// before, just no longer anchored to a required starting heading.
function extractConsiderationsSection(text: string): string {
  let body = text;
  const leadingHeadingMatch = body.match(/^##[^\n]*\n/);
  if (leadingHeadingMatch) {
    body = body.slice(leadingHeadingMatch[0].length);
  }

  let endIndex = body.length;
  const nextHeadingMatch = body.match(/\n##\s/);
  if (nextHeadingMatch?.index !== undefined) {
    endIndex = Math.min(endIndex, nextHeadingMatch.index);
  }
  const separatorMatch = body.match(/\n---\s*\n/);
  if (separatorMatch?.index !== undefined) {
    endIndex = Math.min(endIndex, separatorMatch.index);
  }

  return body.slice(0, endIndex).trim();
}

// Parses one consideration block against the exact field order the prompt
// specifies: bold name line, reason line(s), "Confidence: Low|Moderate" line,
// and an optional "Source: ..." line. Returns null for anything that doesn't
// match — including missing fields, wrong field order, or two blocks that ran
// together without a blank line between them. This is the fail-closed
// replacement for the old loose-candidate cross-check: because every block is
// parsed field-by-field, there is no "well-formed subset" for a malformed
// block to hide behind.
function parseConsiderationBlock(block: string): { name: string; confidence: string } | null {
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 3) return null;

  const nameMatch = lines[0].match(/^\*\*(.+)\*\*$/);
  if (!nameMatch || !nameMatch[1].trim()) return null;

  // The reason is "one short, precise line" per the prompt, but the model can
  // still insert a hard newline mid-sentence on a long reason (observed:
  // picking up the one-field-per-line rhythm of the surrounding structure).
  // Rather than assuming the reason is exactly lines[1], scan forward for the
  // first line that matches the Confidence pattern and treat everything
  // between the name and that line — however many lines — as the reason.
  // This must find a genuine Confidence line to anchor on; if none exists,
  // the block is rejected exactly as before (missing/malformed Confidence).
  const confidenceIndex = lines.findIndex(
    (l, idx) => idx >= 1 && /^Confidence:\s*(Low|Moderate)\s*$/i.test(l),
  );
  if (confidenceIndex === -1) return null;

  const reasonLines = lines.slice(1, confidenceIndex);
  if (reasonLines.length === 0) return null;
  // A reason "line" that itself looks like a drifted Confidence/Source field
  // is genuinely malformed, not a natural wrap — still reject it.
  if (reasonLines.some((l) => /^Confidence:/i.test(l) || /^Source:/i.test(l))) return null;

  const confidenceMatch = lines[confidenceIndex].match(/^Confidence:\s*(Low|Moderate)\s*$/i)!;

  // At most one line may follow Confidence (the optional Source line). More
  // than one means either a second, unseparated block ran on directly after
  // this one, or a genuinely malformed trailer — both rejected the same way
  // the old length bound rejected them.
  const trailing = lines.slice(confidenceIndex + 1);
  if (trailing.length > 1) return null;
  if (trailing.length === 1) {
    const sourceMatch = trailing[0].match(/^Source:\s*(.+)$/i);
    if (!sourceMatch || !sourceMatch[1].trim()) return null;
  }

  return { name: nameMatch[1].trim(), confidence: confidenceMatch[1].toLowerCase() };
}

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

  const section = extractConsiderationsSection(sanitised);
  const blocks = section.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  if (blocks.length === 0) {
    return {
      ok: false,
      reason: "Response contains no diagnostic considerations and no insufficient-evidence sentence",
      code: "DIFFERENTIAL_STRUCTURE_INVALID",
    };
  }

  // Zero-item case: only acceptable if the entire section is exactly the
  // fixed insufficient-evidence sentence — nothing else alongside it. A
  // second block (even a malformed fragment) alongside the sentence must
  // still fail closed rather than being masked by the valid refusal.
  if (blocks.length === 1 && blocks[0] === DIFFERENTIAL_NO_EVIDENCE_SENTENCE) {
    return null;
  }

  // A single well-formed block is a fully valid response — no minimum count.
  // Citation (the Source line) is deliberately NOT required (product
  // decision: always attempt a best-effort list from whatever documented
  // symptoms/history exist, rather than refusing when evidence is thin).
  for (const block of blocks) {
    const parsed = parseConsiderationBlock(block);
    if (!parsed) {
      return {
        ok: false,
        reason:
          "Response contains a consideration block that does not match the required " +
          "name / reason / confidence format",
        code: "DIFFERENTIAL_STRUCTURE_INVALID",
      };
    }

    // parseConsiderationBlock's Confidence regex already guarantees this can
    // only be "low" or "moderate" — kept as defense-in-depth (belt-and-braces
    // against a future edit loosening that regex without updating this
    // alongside it), not as the primary enforcement.
    if (!DIFFERENTIAL_CONFIDENCE_LABELS.includes(parsed.confidence)) {
      return {
        ok: false,
        reason: `Consideration "${parsed.name}" uses a confidence value outside "Low" / "Moderate"`,
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
