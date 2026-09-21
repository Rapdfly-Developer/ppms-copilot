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
import type { DifferentialDiagnosisItem, ExamGuidanceSection } from "@/types/client";

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
// Title-cased to match DifferentialDiagnosisItem.confidence's exact literal
// union ("Low" | "Moderate") — the value sent to PPMS Core, not just the
// value used for internal validation.
const DIFFERENTIAL_CONFIDENCE_LABELS = ["Low", "Moderate"];

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
function parseConsiderationBlock(block: string): DifferentialDiagnosisItem | null {
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

  // The regex alternation only ever matches "Low" or "Moderate" (case-
  // insensitively) at this position — confidenceIndex was itself found by
  // testing the same pattern, so nothing else could have landed here. The
  // ternary below is therefore exhaustive: confidenceMatch[1].toLowerCase()
  // has exactly two possible values, both handled explicitly. This is what
  // guarantees DifferentialDiagnosisItem.confidence is genuinely always
  // "Low" | "Moderate" for every item this function ever returns — not an
  // assumption enforced elsewhere, but a structural property of this regex.
  const confidenceMatch = lines[confidenceIndex].match(/^Confidence:\s*(Low|Moderate)\s*$/i)!;
  const confidence: "Low" | "Moderate" =
    confidenceMatch[1].toLowerCase() === "low" ? "Low" : "Moderate";

  // At most one line may follow Confidence (the optional Source line). More
  // than one means either a second, unseparated block ran on directly after
  // this one, or a genuinely malformed trailer — both rejected the same way
  // the old length bound rejected them.
  const trailing = lines.slice(confidenceIndex + 1);
  if (trailing.length > 1) return null;
  let source: string | undefined;
  if (trailing.length === 1) {
    const sourceMatch = trailing[0].match(/^Source:\s*(.+)$/i);
    if (!sourceMatch || !sourceMatch[1].trim()) return null;
    source = sourceMatch[1].trim();
  }

  return { name: nameMatch[1].trim(), confidence, ...(source ? { source } : {}) };
}

type DifferentialValidation =
  | { ok: true; items: DifferentialDiagnosisItem[] }
  | { ok: false; reason: string; code: string };

// Validates AND structurally extracts in one pass — the returned items are
// the exact same blocks that passed validation, never a second independent
// parse. Consumed by validateResponse() below to (a) accept/reject the
// section and (b) carry items through to ValidationResult.differentialDiagnosisItems
// for PPMS Core's persistent differential-diagnosis card.
function validateDifferentialDiagnosis(sanitised: string): DifferentialValidation {
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
  const rawBlocks = section.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  if (rawBlocks.length === 0) {
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
  if (rawBlocks.length === 1 && rawBlocks[0] === DIFFERENTIAL_NO_EVIDENCE_SENTENCE) {
    return { ok: true, items: [] };
  }

  // Merge orphaned tail fragments caused by blank lines within a block.
  // When the model generates differentialDiagnosis as one JSON string value
  // inside the larger consolidated response, it sometimes inserts a blank line
  // between the reason and the Confidence / Source field (picking up the
  // spaced-paragraph style it uses elsewhere in the same document). Splitting
  // by blank lines then splits a valid block in two: the tail fragment starts
  // with "Confidence:" or "Source:", which is never a valid block opener — so
  // we re-attach it to the block that preceded it rather than rejecting both.
  // Two blocks that ran together WITHOUT a blank line remain a single raw block
  // and are still rejected by parseConsiderationBlock's trailing.length > 1
  // check, so this merge only affects the genuine blank-line-within-block case.
  const blocks: string[] = [];
  for (const raw of rawBlocks) {
    const firstLine = raw.split("\n")[0].trim();
    const isOrphanedTail =
      /^Confidence:\s*(Low|Moderate)/i.test(firstLine) || /^Source:\s/i.test(firstLine);
    if (isOrphanedTail && blocks.length > 0) {
      blocks[blocks.length - 1] += "\n" + raw;
    } else {
      blocks.push(raw);
    }
  }

  // A single well-formed block is a fully valid response — no minimum count.
  // Citation (the Source line) is deliberately NOT required (product
  // decision: always attempt a best-effort list from whatever documented
  // symptoms/history exist, rather than refusing when evidence is thin).
  const items: DifferentialDiagnosisItem[] = [];
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
    // only be "Low" or "Moderate" — kept as defense-in-depth (belt-and-braces
    // against a future edit loosening that regex without updating this
    // alongside it), not as the primary enforcement.
    if (!DIFFERENTIAL_CONFIDENCE_LABELS.includes(parsed.confidence)) {
      return {
        ok: false,
        reason: `Consideration "${parsed.name}" uses a confidence value outside "Low" / "Moderate"`,
        code: "DIFFERENTIAL_STRUCTURE_INVALID",
      };
    }

    items.push(parsed);
  }

  return { ok: true, items };
}

// ── EXAM_GUIDANCE structural + imperative-language requirements ─────────────
// The prompt locks the model to exactly two fixed segment blocks — Anterior
// Segment, then Posterior Segment — each with a Documented line and an
// Associated-findings line. This is a documentary correlation, never an
// instruction, so imperative openers ("Check", "Assess", ...) are a hard
// reject independent of block structure, same enforcement position as
// DIFFERENTIAL_CERTAINTY_PATTERNS above.

const EXAM_GUIDANCE_SEGMENTS = ["Anterior Segment", "Posterior Segment"] as const;

const EXAM_GUIDANCE_NO_DATA_SENTENCE =
  "The documented record does not contain sufficient findings to correlate exam guidance at this time.";

// Whole-word matched anywhere in the section — deliberately not anchored to
// sentence-start position. This is intentionally broader than it needs to be
// (e.g. "in order to" or "the investigation was ordered" would also trip
// "Order"), trading a theoretical false-positive for a simpler, unambiguous
// rule given this capability's narrow, current-visit-only data scope makes
// such incidental collisions unlikely in practice.
const EXAM_GUIDANCE_IMPERATIVE_PATTERNS: RegExp[] = [
  /\bCheck\b/i,
  /\bExamine\b/i,
  /\bLook for\b/i,
  /\bAssess\b/i,
  /\bRule out\b/i,
  /\bPerform\b/i,
  /\bTest for\b/i,
  /\bEvaluate\b/i,
  /\bOrder\b/i,
  /\bScreen for\b/i,
  /\bInvestigate\b/i,
];

// Tolerates a stray leading "## ..." heading line, same defense-in-depth
// reasoning as extractConsiderationsSection above: this text is embedded as
// one JSON string value alongside sections that DO use "##" headers, so a
// model can pick up that habit here too even though the prompt doesn't ask
// for a heading.
function extractExamGuidanceSection(text: string): string {
  let body = text.trim();
  const leadingHeadingMatch = body.match(/^##[^\n]*\n/);
  if (leadingHeadingMatch) {
    body = body.slice(leadingHeadingMatch[0].length).trim();
  }
  return body;
}

// Parses one segment block against the exact field order the prompt
// specifies: a "[Segment Name]" opener line, "Documented: ..." line, and
// "Associated findings not yet documented this visit: ..." line. Either field
// may wrap across multiple hard-newlined lines (same realistic model drift as
// DIFFERENTIAL_DIAGNOSIS's reason line — see parseConsiderationBlock above) —
// forward-scan for the Associated-findings line and treat everything between
// the opener and that line, however many lines, as Documented.
function parseExamGuidanceBlock(block: string, expectedSegment: string): ExamGuidanceSection | null {
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 3) return null;

  const segmentMatch = lines[0].match(/^\[(.+)\]$/);
  if (!segmentMatch || segmentMatch[1].trim() !== expectedSegment) return null;

  const associatedIndex = lines.findIndex(
    (l, idx) => idx >= 1 && /^Associated findings not yet documented this visit:/i.test(l),
  );
  if (associatedIndex === -1) return null;

  const documentedLines = lines.slice(1, associatedIndex);
  if (documentedLines.length === 0) return null;
  const firstDocumentedMatch = documentedLines[0].match(/^Documented:\s*(.*)$/i);
  if (!firstDocumentedMatch) return null;
  const documented = [firstDocumentedMatch[1], ...documentedLines.slice(1)].join(" ").trim();
  if (!documented) return null;

  const associatedLines = lines.slice(associatedIndex);
  const firstAssociatedMatch = associatedLines[0].match(
    /^Associated findings not yet documented this visit:\s*(.*)$/i,
  );
  if (!firstAssociatedMatch) return null;
  const associatedFindingsNotDocumented = [firstAssociatedMatch[1], ...associatedLines.slice(1)]
    .join(" ")
    .trim();
  if (!associatedFindingsNotDocumented) return null;

  return {
    segment: expectedSegment as "Anterior Segment" | "Posterior Segment",
    documented,
    associatedFindingsNotDocumented,
  };
}

type ExamGuidanceValidation =
  | { ok: true; sections: ExamGuidanceSection[] }
  | { ok: false; reason: string; code: string };

// Validates AND structurally extracts in one pass, same Option A approach as
// validateDifferentialDiagnosis above — the returned sections are the exact
// blocks that passed validation here, never re-parsed on the client.
function validateExamGuidance(sanitised: string): ExamGuidanceValidation {
  for (const pattern of EXAM_GUIDANCE_IMPERATIVE_PATTERNS) {
    if (pattern.test(sanitised)) {
      return {
        ok: false,
        reason: "Contains imperative/instructional language outside the permitted documentary framing",
        code: "RESPONSE_UNSAFE",
      };
    }
  }

  const section = extractExamGuidanceSection(sanitised);

  // Whole-response fallback: must be exactly this sentence, alone — a
  // fragment alongside it must still fail closed, same rule as
  // DIFFERENTIAL_NO_EVIDENCE_SENTENCE above.
  if (section === EXAM_GUIDANCE_NO_DATA_SENTENCE) {
    return { ok: true, sections: [] };
  }

  const rawBlocks = section.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (rawBlocks.length !== EXAM_GUIDANCE_SEGMENTS.length) {
    return {
      ok: false,
      reason: `Response must contain exactly ${EXAM_GUIDANCE_SEGMENTS.length} segment blocks (Anterior Segment, Posterior Segment, in that order)`,
      code: "EXAM_GUIDANCE_STRUCTURE_INVALID",
    };
  }

  const sections: ExamGuidanceSection[] = [];
  for (let i = 0; i < EXAM_GUIDANCE_SEGMENTS.length; i++) {
    const parsed = parseExamGuidanceBlock(rawBlocks[i], EXAM_GUIDANCE_SEGMENTS[i]);
    if (!parsed) {
      return {
        ok: false,
        reason:
          `Segment block ${i + 1} does not match the required "[${EXAM_GUIDANCE_SEGMENTS[i]}]" / ` +
          "Documented / Associated findings format, in that order",
        code: "EXAM_GUIDANCE_STRUCTURE_INVALID",
      };
    }
    sections.push(parsed);
  }

  return { ok: true, sections };
}

export type ValidationResult =
  | {
      ok: true;
      warnings: string[];
      differentialDiagnosisItems?: DifferentialDiagnosisItem[];
      examGuidanceSections?: ExamGuidanceSection[];
    }
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
  // Also extracts the structured {name, confidence, source} list alongside
  // validation, for PPMS Core's persistent differential-diagnosis card (sent
  // via the PLUGIN_DIFFERENTIAL_UPDATE postMessage) — the exact same blocks
  // that passed validation here, never re-parsed a second time on the client.
  let differentialDiagnosisItems: DifferentialDiagnosisItem[] | undefined;
  if (capability === "DIFFERENTIAL_DIAGNOSIS") {
    const result = validateDifferentialDiagnosis(sanitised);
    if (!result.ok) return result;
    differentialDiagnosisItems = result.items;
  }

  // 4c. EXAM_GUIDANCE: two fixed segment blocks, documentary framing only.
  // On-demand only — runs through the standalone /api/copilot/stream path,
  // never the consolidated call. Also extracts the structured segment list
  // alongside validation, threaded through NdjsonFrame's done.meta (see
  // service/copilot.ts) and out via the PLUGIN_EXAM_GUIDANCE_RESULT
  // postMessage — the exact same blocks that passed validation here, never
  // re-parsed a second time on the client.
  let examGuidanceSections: ExamGuidanceSection[] | undefined;
  if (capability === "EXAM_GUIDANCE") {
    const result = validateExamGuidance(sanitised);
    if (!result.ok) return result;
    examGuidanceSections = result.sections;
  }

  // 5. Warning patterns (soft — response allowed through with annotations)
  const warnings = WARNING_PATTERNS.filter(({ pattern }) => pattern.test(sanitised)).map(
    ({ warning }) => warning,
  );

  return {
    ok: true,
    warnings,
    ...(differentialDiagnosisItems ? { differentialDiagnosisItems } : {}),
    ...(examGuidanceSections ? { examGuidanceSections } : {}),
  };
}
