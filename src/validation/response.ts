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
import type {
  DifferentialDiagnosisItem,
  DifferentialReasonCitation,
  DiagnosisComparisonResult,
  ExamGuidanceSection,
  RefractiveGuidanceResult,
  RefractiveEyeGuidance,
  PlanGuidanceResult,
  InvestigationGuidanceResult,
  SuggestedInvestigationItem,
} from "@/types/client";
import type { DocumentedFlags } from "@/lib/ppms-client";
import type { GovtSchemeEntry } from "@/lib/govt-schemes";

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
function parseConsiderationBlock(block: string): (DifferentialDiagnosisItem & { reason: string }) | null {
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

  return { name: nameMatch[1].trim(), confidence, reason: reasonLines.join("\n"), ...(source ? { source } : {}) };
}

type DifferentialValidation =
  | { ok: true; items: DifferentialDiagnosisItem[]; reasons: DifferentialReasonCitation[] }
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
    return { ok: true, items: [], reasons: [] };
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
  const reasons: DifferentialReasonCitation[] = [];
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

    const { reason, ...item } = parsed;
    items.push(item);
    reasons.push({ name: item.name, reason });
  }

  return { ok: true, items, reasons };
}

// ── Shared imperative-language check ──────────────────────────────────────────
// Any capability whose task is a documentary correlation of exam-adjacent
// findings — never an instruction — needs this same hard reject. Originally
// EXAM_GUIDANCE-only (EXAM_GUIDANCE_IMPERATIVE_PATTERNS); extracted here when
// REFRACTIVE_GUIDANCE needed the identical check, rather than a second
// copy-pasted list that could quietly drift from the first.
//
// Whole-word matched anywhere in the section — deliberately not anchored to
// sentence-start position. This is intentionally broader than it needs to be
// (e.g. "in order to" or "the investigation was ordered" would also trip
// "Order"), trading a theoretical false-positive for a simpler, unambiguous
// rule given these capabilities' narrow, current-visit-only data scope makes
// such incidental collisions unlikely in practice.
const IMPERATIVE_LANGUAGE_PATTERNS: RegExp[] = [
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

// ── EXAM_GUIDANCE structural requirements ────────────────────────────────────
// The prompt locks the model to exactly two fixed segment blocks — Anterior
// Segment, then Posterior Segment — each with a Documented line and an
// Associated-findings line.

const EXAM_GUIDANCE_SEGMENTS = ["Anterior Segment", "Posterior Segment"] as const;

const EXAM_GUIDANCE_NO_DATA_SENTENCE =
  "The documented record does not contain sufficient findings to correlate exam guidance at this time.";

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
  for (const pattern of IMPERATIVE_LANGUAGE_PATTERNS) {
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

// ── REFRACTIVE_GUIDANCE structural + ground-truth requirements ──────────────
// The prompt locks the model to exactly three blocks — Right Eye, Left Eye,
// Routing — in that order. The two eye blocks follow the same
// Documented/interpretation two-field shape (with the same wrap-tolerant
// forward-scan as parseExamGuidanceBlock). The Routing block is different in
// kind: its four sub-tab lines are not free text to validate structurally —
// they are checked against the REAL DocumentedFlags object passed in as
// `documented`, and ANY mismatch fails the whole response closed. This is the
// safety property the whole capability exists to prove: the model phrases
// the sentence, it never gets to decide the fact.

const REFRACTIVE_EYES = ["Right Eye", "Left Eye"] as const;

// Unlike EXAM_GUIDANCE's whole-response fallback, each eye's fallback is
// independent — one eye can have documented refraction/VA while the other
// doesn't. So there's no single "is the whole response exactly this
// sentence" check to make here: the fallback pair the prompt specifies
// ("No refraction or visual acuity documented..." / "No refractive
// interpretation possible...") is just ordinary non-empty field text as far
// as parseRefractiveEyeBlock is concerned, same as any other Documented/
// interpretation content.

// Fixed label → DocumentedFlags key, in the exact order the prompt specifies.
const REFRACTIVE_ROUTING_FIELDS: { label: string; key: keyof DocumentedFlags }[] = [
  { label: "Visual Acuity", key: "visualAcuity" },
  { label: "Refraction", key: "refraction" },
  { label: "Anterior Segment", key: "anteriorSegment" },
  { label: "Posterior Segment", key: "posteriorSegment" },
];

// Parses one eye block against the exact field order the prompt specifies: a
// "[Eye Name]" opener line, "Documented: ..." line, and "Refractive
// interpretation: ..." line. Either field may wrap across multiple
// hard-newlined lines — same forward-scan tolerance as parseExamGuidanceBlock
// above, same realistic model-drift reasoning.
function parseRefractiveEyeBlock(block: string, expectedEye: string): RefractiveEyeGuidance | null {
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 3) return null;

  const headerMatch = lines[0].match(/^\[(.+)\]$/);
  if (!headerMatch || headerMatch[1].trim() !== expectedEye) return null;

  const interpretationIndex = lines.findIndex(
    (l, idx) => idx >= 1 && /^Refractive interpretation:/i.test(l),
  );
  if (interpretationIndex === -1) return null;

  const documentedLines = lines.slice(1, interpretationIndex);
  if (documentedLines.length === 0) return null;
  const firstDocMatch = documentedLines[0].match(/^Documented:\s*(.*)$/i);
  if (!firstDocMatch) return null;
  const documented = [firstDocMatch[1], ...documentedLines.slice(1)].join(" ").trim();
  if (!documented) return null;

  const interpretationLines = lines.slice(interpretationIndex);
  const firstInterpMatch = interpretationLines[0].match(/^Refractive interpretation:\s*(.*)$/i);
  if (!firstInterpMatch) return null;
  const interpretation = [firstInterpMatch[1], ...interpretationLines.slice(1)].join(" ").trim();
  if (!interpretation) return null;

  return { eye: expectedEye as "Right Eye" | "Left Eye", documented, interpretation };
}

// Parses the [Routing] block: four fixed-label "Documented"/"Not documented"
// lines, each cross-checked against the real `documented` flags — a claim
// that doesn't match the ground truth fails the block, not just that field —
// followed by a free-text "Guidance:" line (same wrap tolerance as elsewhere).
function parseRefractiveRoutingBlock(
  block: string,
  documented: DocumentedFlags,
): RefractiveGuidanceResult["routing"] | null {
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2 + REFRACTIVE_ROUTING_FIELDS.length) return null;

  const headerMatch = lines[0].match(/^\[(.+)\]$/);
  if (!headerMatch || headerMatch[1].trim() !== "Routing") return null;

  const flags: Partial<Record<keyof DocumentedFlags, boolean>> = {};
  for (let i = 0; i < REFRACTIVE_ROUTING_FIELDS.length; i++) {
    const { label, key } = REFRACTIVE_ROUTING_FIELDS[i];
    const line = lines[1 + i];
    if (!line) return null;
    const match = line.match(/^([A-Za-z ]+):\s*(Documented|Not documented)\s*$/i);
    if (!match || match[1].trim() !== label) return null;
    const claimed = match[2].toLowerCase() === "documented";
    if (claimed !== documented[key]) return null; // ground-truth mismatch — fail closed
    flags[key] = claimed;
  }

  const guidanceLines = lines.slice(1 + REFRACTIVE_ROUTING_FIELDS.length);
  if (guidanceLines.length === 0) return null;
  const firstGuidanceMatch = guidanceLines[0].match(/^Guidance:\s*(.*)$/i);
  if (!firstGuidanceMatch) return null;
  const guidance = [firstGuidanceMatch[1], ...guidanceLines.slice(1)].join(" ").trim();
  if (!guidance) return null;

  return {
    visualAcuityDocumented: flags.visualAcuity!,
    refractionDocumented: flags.refraction!,
    anteriorSegmentDocumented: flags.anteriorSegment!,
    posteriorSegmentDocumented: flags.posteriorSegment!,
    guidance,
  };
}

type RefractiveGuidanceValidation =
  | { ok: true; result: RefractiveGuidanceResult }
  | { ok: false; reason: string; code: string };

function validateRefractiveGuidance(
  sanitised: string,
  documented: DocumentedFlags | undefined,
): RefractiveGuidanceValidation {
  for (const pattern of IMPERATIVE_LANGUAGE_PATTERNS) {
    if (pattern.test(sanitised)) {
      return {
        ok: false,
        reason: "Contains imperative/instructional language outside the permitted documentary framing",
        code: "RESPONSE_UNSAFE",
      };
    }
  }

  // No ground truth available — fail closed rather than validating routing
  // claims against nothing, which would let any claim through unchecked.
  if (!documented) {
    return {
      ok: false,
      reason: "Missing sub-tab documentation status — cannot verify routing claims",
      code: "REFRACTIVE_GUIDANCE_STRUCTURE_INVALID",
    };
  }

  const rawBlocks = sanitised.trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (rawBlocks.length !== 3) {
    return {
      ok: false,
      reason: "Response must contain exactly 3 blocks (Right Eye, Left Eye, Routing, in that order)",
      code: "REFRACTIVE_GUIDANCE_STRUCTURE_INVALID",
    };
  }

  const eyes: RefractiveEyeGuidance[] = [];
  for (let i = 0; i < REFRACTIVE_EYES.length; i++) {
    const parsed = parseRefractiveEyeBlock(rawBlocks[i], REFRACTIVE_EYES[i]);
    if (!parsed) {
      return {
        ok: false,
        reason:
          `Block ${i + 1} does not match the required "[${REFRACTIVE_EYES[i]}]" / Documented / ` +
          "Refractive interpretation format, in that order",
        code: "REFRACTIVE_GUIDANCE_STRUCTURE_INVALID",
      };
    }
    eyes.push(parsed);
  }

  const routing = parseRefractiveRoutingBlock(rawBlocks[2], documented);
  if (!routing) {
    return {
      ok: false,
      reason:
        "Routing block does not match the required format, or its claims do not match the " +
        "actual sub-tab documentation status",
      code: "REFRACTIVE_GUIDANCE_STRUCTURE_INVALID",
    };
  }

  return { ok: true, result: { eyes, routing } };
}

// ── PLAN_GUIDANCE structural + retrospective-only + govt-scheme requirements ──
// Two required blocks (Documented Progression, Comforting Methods), always in
// that order, plus an OPTIONAL third block (Govt Scheme). Its presence is
// itself ground-truth-checked: it may appear ONLY when groundTruth.matchedScheme
// was provided, and its four fields must then match that entry EXACTLY — the
// model cites, it never composes. Omitting the block is always acceptable
// (never a violation), matching the "fail closed, omit rather than guess"
// rule this whole sub-feature exists to enforce.

// Separate from IMPERATIVE_LANGUAGE_PATTERNS — this capability's Documented
// Progression field is retrospective-only by design (it describes changes
// that already happened, from the pre-computed CLINICAL EVIDENCE section),
// so forward-looking treatment framing is a hard reject here even where it
// wouldn't be flagged as a command. Deliberately not anchored to sentence
// position, same reasoning as IMPERATIVE_LANGUAGE_PATTERNS above.
const PROSPECTIVE_TREATMENT_PATTERNS: RegExp[] = [
  /\bnext step\b/i,
  /\bif\s+[\w\s]{0,30}\bfails?\b/i,
  /\btry\b/i,
  /\bconsider escalating\b/i,
  /\bescalat(?:e|ing|ed)\s+to\b/i,
  /\bmay be considered\b/i,
  /\bshould be escalated\b/i,
  /\bstep up to\b/i,
  /\bcould (?:be )?(?:tried|attempted|added) next\b/i,
  /\bif (?:no|insufficient) (?:response|improvement)\b/i,

  // Round 2 — subtler hedged-prospective phrasing a real model reaches for
  // just as naturally as the constructions above, found by re-checking this
  // list against plausible model output rather than only the literal
  // examples that seeded it originally.
  /\bcould be considered\b/i,
  /\bwould be considered\b/i,
  /\bmay be warranted\b/i,
  /\bcould be warranted\b/i,
  /\bmay benefit from\b/i,
  /\bwould benefit from (?:an? )?(?:additional|further|second)\b/i,
  /\bsecond[- ]line option\b/i,
  /\ba reasonable next\b/i,
  /\bfurther options?\s+(?:include|would include|may include)\b/i,
  /\bmay require (?:escalation|an? additional|further)\b/i,
  /\bmay need (?:escalation|an? additional|further)\b/i,
  /\bwarrants?\s+(?:consideration|escalation)\b/i,
  /\bshould\s+\w+(?:\s+\w+){0,4}\s+prove\s+(?:inadequate|insufficient|ineffective)\b/i,
  /\bif\s+(?:unresponsive|refractory)\s+to\b/i,
  /\bif\s+(?:uncontrolled|poorly controlled|inadequately controlled)\b/i,
  /\ban? additional agent\s+(?:may|could|would)\b/i,
  /\bcould\s+(?:progress|escalate)\s+to\b/i,
];

// Finds each label's line (in order, each after the previous), then joins
// that field's value from its label line through the line before the next
// label (or end of the segment for the last label) — same wrap-tolerant
// forward-scan reasoning as parseExamGuidanceBlock/parseRefractiveEyeBlock
// above, generalised to an arbitrary ordered label list.
function parseLabeledFields(lines: string[], labels: string[]): string[] | null {
  const indices: number[] = [];
  let searchFrom = 0;
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}:`, "i");
    const idx = lines.findIndex((l, i) => i >= searchFrom && pattern.test(l));
    if (idx === -1) return null;
    indices.push(idx);
    searchFrom = idx + 1;
  }

  const values: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const start = indices[i];
    const end = i + 1 < labels.length ? indices[i + 1] : lines.length;
    const segment = lines.slice(start, end);
    const escaped = labels[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const firstMatch = segment[0].match(new RegExp(`^${escaped}:\\s*(.*)$`, "i"));
    if (!firstMatch) return null;
    const value = [firstMatch[1], ...segment.slice(1)].join(" ").trim();
    if (!value) return null;
    values.push(value);
  }
  return values;
}

function parsePlanHeaderBlock(block: string, expectedHeader: string, fieldLabels: string[]): string[] | null {
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 1 + fieldLabels.length) return null;

  const headerMatch = lines[0].match(/^\[(.+)\]$/);
  if (!headerMatch || headerMatch[1].trim() !== expectedHeader) return null;

  return parseLabeledFields(lines.slice(1), fieldLabels);
}

const GOVT_SCHEME_FIELD_LABELS = ["Scheme", "Description", "Eligibility", "Last verified"];

type PlanGuidanceValidation =
  | { ok: true; result: PlanGuidanceResult }
  | { ok: false; reason: string; code: string };

function validatePlanGuidance(
  sanitised: string,
  matchedScheme: GovtSchemeEntry | undefined,
): PlanGuidanceValidation {
  for (const pattern of IMPERATIVE_LANGUAGE_PATTERNS) {
    if (pattern.test(sanitised)) {
      return {
        ok: false,
        reason: "Contains imperative/instructional language outside the permitted documentary framing",
        code: "RESPONSE_UNSAFE",
      };
    }
  }

  for (const pattern of PROSPECTIVE_TREATMENT_PATTERNS) {
    if (pattern.test(sanitised)) {
      return {
        ok: false,
        reason: "Contains prospective/future-tense treatment-escalation language — this section must be retrospective only",
        code: "RESPONSE_UNSAFE",
      };
    }
  }

  const rawBlocks = sanitised.trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (rawBlocks.length !== 2 && rawBlocks.length !== 3) {
    return {
      ok: false,
      reason:
        "Response must contain exactly 2 blocks (Documented Progression, Comforting Methods) " +
        "or 3 when a Govt Scheme is cited, in that order",
      code: "PLAN_GUIDANCE_STRUCTURE_INVALID",
    };
  }

  const progressionFields = parsePlanHeaderBlock(rawBlocks[0], "Documented Progression", ["Progression"]);
  if (!progressionFields) {
    return {
      ok: false,
      reason: 'Block 1 does not match the required "[Documented Progression]" / Progression format',
      code: "PLAN_GUIDANCE_STRUCTURE_INVALID",
    };
  }

  const comfortingFields = parsePlanHeaderBlock(rawBlocks[1], "Comforting Methods", ["Guidance"]);
  if (!comfortingFields) {
    return {
      ok: false,
      reason: 'Block 2 does not match the required "[Comforting Methods]" / Guidance format',
      code: "PLAN_GUIDANCE_STRUCTURE_INVALID",
    };
  }

  let govtScheme: PlanGuidanceResult["govtScheme"];
  if (rawBlocks.length === 3) {
    // A Govt Scheme block is only ever valid when a match was actually given —
    // its mere presence without a matchedScheme means the model fabricated
    // one, which fails closed regardless of what it says.
    if (!matchedScheme) {
      return {
        ok: false,
        reason: "Response includes a Govt Scheme block, but no scheme was matched for this record",
        code: "PLAN_GUIDANCE_STRUCTURE_INVALID",
      };
    }

    const fields = parsePlanHeaderBlock(rawBlocks[2], "Govt Scheme", GOVT_SCHEME_FIELD_LABELS);
    if (!fields) {
      return {
        ok: false,
        reason: 'Block 3 does not match the required "[Govt Scheme]" / Scheme / Description / Eligibility / Last verified format',
        code: "PLAN_GUIDANCE_STRUCTURE_INVALID",
      };
    }

    const [schemeName, description, eligibilitySummary, lastVerified] = fields;
    const matches =
      schemeName === matchedScheme.schemeName &&
      description === matchedScheme.description &&
      eligibilitySummary === matchedScheme.eligibilitySummary &&
      lastVerified === matchedScheme.lastVerified;

    if (!matches) {
      return {
        ok: false,
        reason: "Govt Scheme block does not exactly match the matched scheme's fields — citation must be verbatim",
        code: "PLAN_GUIDANCE_STRUCTURE_INVALID",
      };
    }

    govtScheme = { schemeName, description, eligibilitySummary, lastVerified };
  }

  return {
    ok: true,
    result: {
      documentedProgression: progressionFields[0],
      comfortingGuidance: comfortingFields[0],
      ...(govtScheme ? { govtScheme } : {}),
    },
  };
}

// ── INVESTIGATION_GUIDANCE correlative-only + structural requirements ────────
// Structurally closest to DIFFERENTIAL_DIAGNOSIS's variable-length,
// confidence-graded block list — not to PLAN_GUIDANCE's fixed block count,
// since there's no equivalent "retrospective only" boundary here (suggesting
// an investigation not yet in the record is inherently prospective; there is
// nothing to be retrospective about). The guardrail instead is correlative
// framing: never an instruction, and never a non-imperative but still
// directive/requirement construction (DIRECTIVE_LANGUAGE_PATTERNS, below).

// Deliberately NOT the shared IMPERATIVE_LANGUAGE_PATTERNS — found via this
// capability's own test suite, not by inspection: the shared list bans
// "Assess," "Evaluate," "Screen for," "Test for," and "Investigate" anywhere
// in the text, which is safe for EXAM_GUIDANCE/REFRACTIVE_GUIDANCE/
// PLAN_GUIDANCE (none of them ever need to say what a test is FOR), but
// breaks this capability outright — its entire correlative premise is
// describing an investigation's purpose ("commonly used to assess X",
// per the prompt's own required example), so those five verbs appear
// constantly in legitimate, non-directive output. "Check," "Examine," "Look
// for," "Rule out," and "Order" have no such legitimate purpose-description
// use here and stay banned unchanged.
const INVESTIGATION_GUIDANCE_IMPERATIVE_PATTERNS: RegExp[] = [
  /\bCheck\b/i,
  /\bExamine\b/i,
  /\bLook for\b/i,
  /\bRule out\b/i,
  /\bPerform\b/i,
  /\bOrder\b/i,
];

// Separate from IMPERATIVE_LANGUAGE_PATTERNS — these are directive/
// requirement constructions that never read as a command verb ("Order X")
// but still tell the doctor an investigation is needed, which this
// capability's correlative-only framing forbids just as much. Deliberately
// NOT anchored to sentence position, same reasoning as
// IMPERATIVE_LANGUAGE_PATTERNS/PROSPECTIVE_TREATMENT_PATTERNS above.
//
// "should be considered" / "could be considered" are deliberately NOT
// included here — live-tested separately as a possible soft-directive escape
// hatch around the patterns below before deciding whether they need their
// own entry (same "am I only testing what I wrote" discipline PLAN_GUIDANCE's
// PROSPECTIVE_TREATMENT_PATTERNS list went through).
const DIRECTIVE_LANGUAGE_PATTERNS: RegExp[] = [
  /\bshould undergo\b/i,
  /\bneeds?\b/i,
  /\brequires?\b/i,
  /\bmust be (?:ordered|obtained|performed|scheduled|done)\b/i,

  // Round 2 — other directive constructions a model reaches for just as
  // naturally, found by checking this list against plausible phrasing rather
  // than only the four literal examples that seeded it.
  /\bshould be (?:ordered|obtained|performed|scheduled|done|pursued|arranged|sent)\b/i,
  /\bis (?:indicated|warranted|necessary)\b/i,
  /\bwould be (?:indicated|warranted|advisable|necessary)\b/i,
  /\bwarrants?\b/i,
  /\brecommend(?:ed|s|ing)?\b/i,
  /\badvised\b/i,
  /\bought to (?:be|undergo)\b/i,
];

const INVESTIGATION_GUIDANCE_NO_SUGGESTION_SENTENCE =
  "No additional investigations are suggested based on the documented record at this time.";

// Same leading-heading tolerance as extractConsiderationsSection above — this
// text is embedded as one JSON string value alongside sections that DO use
// "##" headers, so a model can pick up that habit here too even though the
// prompt doesn't ask for one. No trailing-boundary logic is needed (unlike
// Differential Diagnosis's Documentation Gaps section) since nothing follows
// the suggestion list within this key's string.
function extractSuggestionsSection(text: string): string {
  const leadingHeadingMatch = text.match(/^##[^\n]*\n/);
  return leadingHeadingMatch ? text.slice(leadingHeadingMatch[0].length).trim() : text.trim();
}

// Parses one suggestion block against the exact field order the prompt
// specifies: bold name line, rationale line(s), "Confidence: Low|Moderate"
// line, and an optional "Source: ..." line. Same wrap-tolerant forward-scan
// as parseConsiderationBlock above, but — unlike DifferentialDiagnosisItem —
// the rationale text is kept, not discarded, since it's the substance of
// what this capability surfaces, not just a compact badge.
function parseSuggestionBlock(block: string): SuggestedInvestigationItem | null {
  const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 3) return null;

  const nameMatch = lines[0].match(/^\*\*(.+)\*\*$/);
  if (!nameMatch || !nameMatch[1].trim()) return null;

  const confidenceIndex = lines.findIndex(
    (l, idx) => idx >= 1 && /^Confidence:\s*(Low|Moderate)\s*$/i.test(l),
  );
  if (confidenceIndex === -1) return null;

  const rationaleLines = lines.slice(1, confidenceIndex);
  if (rationaleLines.length === 0) return null;
  if (rationaleLines.some((l) => /^Confidence:/i.test(l) || /^Source:/i.test(l))) return null;

  const confidenceMatch = lines[confidenceIndex].match(/^Confidence:\s*(Low|Moderate)\s*$/i)!;
  const confidence: "Low" | "Moderate" =
    confidenceMatch[1].toLowerCase() === "low" ? "Low" : "Moderate";

  const trailing = lines.slice(confidenceIndex + 1);
  if (trailing.length > 1) return null;
  let source: string | undefined;
  if (trailing.length === 1) {
    const sourceMatch = trailing[0].match(/^Source:\s*(.+)$/i);
    if (!sourceMatch || !sourceMatch[1].trim()) return null;
    source = sourceMatch[1].trim();
  }

  return {
    name: nameMatch[1].trim(),
    rationale: rationaleLines.join(" ").trim(),
    confidence,
    ...(source ? { source } : {}),
  };
}

type InvestigationGuidanceValidation =
  | { ok: true; result: InvestigationGuidanceResult }
  | { ok: false; reason: string; code: string };

function validateInvestigationGuidance(sanitised: string): InvestigationGuidanceValidation {
  for (const pattern of INVESTIGATION_GUIDANCE_IMPERATIVE_PATTERNS) {
    if (pattern.test(sanitised)) {
      return {
        ok: false,
        reason: "Contains imperative/instructional language outside the permitted correlative framing",
        code: "RESPONSE_UNSAFE",
      };
    }
  }

  for (const pattern of DIRECTIVE_LANGUAGE_PATTERNS) {
    if (pattern.test(sanitised)) {
      return {
        ok: false,
        reason: "Contains directive or requirement language — investigation suggestions must be correlative only",
        code: "RESPONSE_UNSAFE",
      };
    }
  }

  const section = extractSuggestionsSection(sanitised);
  const rawBlocks = section.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  if (rawBlocks.length === 0) {
    return {
      ok: false,
      reason: "Response contains no investigation suggestions and no fixed no-suggestion sentence",
      code: "INVESTIGATION_GUIDANCE_STRUCTURE_INVALID",
    };
  }

  // Zero-item case: only acceptable if the entire section is exactly the
  // fixed no-suggestion sentence — nothing else alongside it. Same
  // "fail closed" reasoning as validateDifferentialDiagnosis's zero-item case.
  if (rawBlocks.length === 1 && rawBlocks[0] === INVESTIGATION_GUIDANCE_NO_SUGGESTION_SENTENCE) {
    return { ok: true, result: { suggestedInvestigations: [] } };
  }

  // Merge orphaned tail fragments caused by a blank line within a block —
  // same reasoning as validateDifferentialDiagnosis above.
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

  const suggestedInvestigations: SuggestedInvestigationItem[] = [];
  for (const block of blocks) {
    const parsed = parseSuggestionBlock(block);
    if (!parsed) {
      return {
        ok: false,
        reason:
          "Response contains a suggestion block that does not match the required " +
          "name / rationale / confidence format",
        code: "INVESTIGATION_GUIDANCE_STRUCTURE_INVALID",
      };
    }
    suggestedInvestigations.push(parsed);
  }

  // investigationsSummary is deliberately left unset here — it's threaded
  // post-hoc in service/copilot-generate.ts from the already-validated
  // INVESTIGATIONS_SUMMARY section, same pattern as PlanGuidanceResult.followUpSummary.
  return { ok: true, result: { suggestedInvestigations } };
}

// Scoped exception: descriptive "do not rule out" is permitted here only.
const DIAGNOSIS_COMPARISON_IMPERATIVE_PATTERNS = IMPERATIVE_LANGUAGE_PATTERNS.filter(
  (pattern) => pattern.source !== /\bRule out\b/i.source,
);
const OVERRIDING_LANGUAGE_PATTERNS = [
  /\bincorrect\b/i, /\bwrong\b/i, /\bshould be\b/i, /\bmisdiagnosed\b/i,
  /\bshould have been\b/i, /\bis actually\b/i, /\bmistaken\b/i,
];

function validateDiagnosisComparison(text: string):
  | { ok: true; result: DiagnosisComparisonResult }
  | { ok: false; code: string; reason: string } {
  if ([...DIAGNOSIS_COMPARISON_IMPERATIVE_PATTERNS, ...OVERRIDING_LANGUAGE_PATTERNS]
    .some((pattern) => pattern.test(text))) {
    return { ok: false, code: "RESPONSE_UNSAFE", reason: "Contains imperative or overriding language" };
  }
  const normalised = text.replace(/\r\n/g, "\n").trim();
  if (normalised === "[Plausibility]\nNot applicable — no documented diagnosis for this visit.") {
    return { ok: true, result: {} };
  }
  const match = normalised.match(/^\[Plausibility\]\s*\nAssessment: (Plausible|Worth reviewing)\s*\nReason: ([^\n]+)$/);
  if (!match || !match[2].trim()) {
    return { ok: false, code: "DIAGNOSIS_COMPARISON_STRUCTURE_INVALID", reason: "Expected a single Plausibility block" };
  }
  return { ok: true, result: { plausibility: {
    assessment: match[1] as "Plausible" | "Worth reviewing", reason: match[2].trim(),
  } } };
}

export type ValidationResult =
  | {
      ok: true;
      warnings: string[];
      differentialDiagnosisItems?: DifferentialDiagnosisItem[];
      differentialReasonCitations?: DifferentialReasonCitation[];
      diagnosisComparisonResult?: DiagnosisComparisonResult;
      examGuidanceSections?: ExamGuidanceSection[];
      refractiveGuidanceResult?: RefractiveGuidanceResult;
      planGuidanceResult?: PlanGuidanceResult;
      investigationGuidanceResult?: InvestigationGuidanceResult;
    }
  | { ok: false; reason: string; code: string };

export function validateResponse(
  text: string,
  capability: Capability,
  stopReason?: string,
  groundTruth?: { documented?: DocumentedFlags; matchedScheme?: GovtSchemeEntry },
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
  let differentialReasonCitations: DifferentialReasonCitation[] | undefined;
  if (capability === "DIFFERENTIAL_DIAGNOSIS") {
    // Safety checks above inspect the sanitised text; citations preserve the
    // original accepted wording, matching the existing displayed DDx text.
    const result = validateDifferentialDiagnosis(text);
    if (!result.ok) return result;
    differentialDiagnosisItems = result.items;
    differentialReasonCitations = result.reasons;
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

  // 4d. REFRACTIVE_GUIDANCE: two eye blocks plus a routing block whose four
  // sub-tab claims are cross-checked against groundTruth.documented (the real
  // DocumentedFlags PPMS Core computed) — not just structurally validated.
  // On-demand only, same transport as EXAM_GUIDANCE.
  let refractiveGuidanceResult: RefractiveGuidanceResult | undefined;
  if (capability === "REFRACTIVE_GUIDANCE") {
    const result = validateRefractiveGuidance(sanitised, groundTruth?.documented);
    if (!result.ok) return result;
    refractiveGuidanceResult = result.result;
  }

  // 4e. PLAN_GUIDANCE: retrospective progression + comforting guidance,
  // plus an optional Govt Scheme block whose presence and content are
  // cross-checked against groundTruth.matchedScheme. Eager/consolidated,
  // unlike EXAM_GUIDANCE/REFRACTIVE_GUIDANCE.
  let planGuidanceResult: PlanGuidanceResult | undefined;
  if (capability === "PLAN_GUIDANCE") {
    const result = validatePlanGuidance(sanitised, groundTruth?.matchedScheme);
    if (!result.ok) return result;
    planGuidanceResult = result.result;
  }

  // 4f. INVESTIGATION_GUIDANCE: variable-length, confidence-graded list of
  // correlative investigation suggestions — structurally closest to
  // DIFFERENTIAL_DIAGNOSIS, not to PLAN_GUIDANCE's fixed block count.
  // Eager/consolidated, same reasoning as PLAN_GUIDANCE.
  let investigationGuidanceResult: InvestigationGuidanceResult | undefined;
  if (capability === "INVESTIGATION_GUIDANCE") {
    const result = validateInvestigationGuidance(sanitised);
    if (!result.ok) return result;
    investigationGuidanceResult = result.result;
  }

  let diagnosisComparisonResult: DiagnosisComparisonResult | undefined;
  if (capability === "DIAGNOSIS_COMPARISON") {
    const result = validateDiagnosisComparison(sanitised);
    if (!result.ok) return result;
    diagnosisComparisonResult = result.result;
  }

  // 5. Warning patterns (soft — response allowed through with annotations)
  const warnings = WARNING_PATTERNS.filter(({ pattern }) => pattern.test(sanitised)).map(
    ({ warning }) => warning,
  );

  return {
    ok: true,
    warnings,
    ...(differentialDiagnosisItems ? { differentialDiagnosisItems } : {}),
    ...(differentialReasonCitations ? { differentialReasonCitations } : {}),
    ...(diagnosisComparisonResult ? { diagnosisComparisonResult } : {}),
    ...(examGuidanceSections ? { examGuidanceSections } : {}),
    ...(refractiveGuidanceResult ? { refractiveGuidanceResult } : {}),
    ...(planGuidanceResult ? { planGuidanceResult } : {}),
    ...(investigationGuidanceResult ? { investigationGuidanceResult } : {}),
  };
}
