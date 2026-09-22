// Government health-scheme reference table for PLAN_GUIDANCE.
//
// ═══════════════════════════════════════════════════════════════════════════
// PLACEHOLDER DATA — NOT INDEPENDENTLY VERIFIED. DO NOT SHIP WITHOUT REVIEW.
// The two entries below were authored from general knowledge of well-known
// national Indian eye-care/health schemes (Ayushman Bharat PM-JAY, NPCBVI).
// Their names, descriptions, and eligibility summaries have NOT been checked
// against a live government source as part of this change. Confirm accuracy,
// current scheme names, and eligibility criteria — and add/remove state-level
// schemes relevant to your deployment — before this is relied on by a doctor
// advising a real patient.
// ═══════════════════════════════════════════════════════════════════════════
//
// Matching is deterministic application code (ICD-10 prefix or keyword
// substring against the current visit's documented diagnoses), same pattern
// as PPMS Core's own treatmentPresets.ts matchPresets(). The AI never selects
// or invents a scheme — it only cites, verbatim, whichever single entry (if
// any) this matcher returns. See validation/response.ts's validatePlanGuidance,
// which rejects any response whose Govt Scheme block doesn't exactly match
// this entry's fields, and requires the block be ABSENT entirely when no
// match was found.

export type GovtSchemeEntry = {
  id: string;
  conditionKeywords: string[]; // lowercase substring match against diagnosis description
  conditionIcdPrefixes: string[]; // ICD-10 prefix match, e.g. "H25" matches H25.1, H25.9
  schemeName: string;
  description: string;
  eligibilitySummary: string;
  lastVerified: string; // ISO date — when this table entry was last authored/reviewed
};

export const GOVT_SCHEMES: GovtSchemeEntry[] = [
  {
    id: "ab-pmjay",
    conditionKeywords: ["cataract", "phacoemulsification", "pseudophakia"],
    conditionIcdPrefixes: ["H25", "H26"],
    schemeName: "Ayushman Bharat – Pradhan Mantri Jan Arogya Yojana (AB-PMJAY)",
    description:
      "National health insurance scheme covering secondary and tertiary hospitalisation, " +
      "including cataract surgery, for economically vulnerable families identified via the " +
      "SECC database.",
    eligibilitySummary:
      "Families listed under SECC 2011 deprivation criteria; verify current eligibility via " +
      "the PM-JAY portal or nearest empanelled hospital.",
    lastVerified: "2026-09-21",
  },
  {
    id: "npcbvi",
    conditionKeywords: ["cataract", "refractive error", "blindness", "low vision"],
    conditionIcdPrefixes: ["H25", "H26", "H52"],
    schemeName: "National Programme for Control of Blindness and Visual Impairment (NPCBVI)",
    description:
      "Government of India programme providing free or subsidised cataract surgery and free " +
      "spectacles for schoolchildren through district-level blindness control societies.",
    eligibilitySummary:
      "Generally available through government and empanelled eye-care centres; eligibility " +
      "and coverage vary by state and district — verify with the local District Blindness " +
      "Control Society.",
    lastVerified: "2026-09-21",
  },
];

// Matches the current visit's documented diagnoses against the table above.
// Returns the FIRST matching entry, or null if none match — never a "best
// guess" or partial match. A visit with multiple matchable diagnoses still
// returns only one entry (the earliest table entry that matches any of
// them), keeping the Plan Guidance card to a single scheme reference.
export function matchGovtScheme(
  diagnoses: { icd10Code?: string; description: string }[],
): GovtSchemeEntry | null {
  for (const entry of GOVT_SCHEMES) {
    for (const diag of diagnoses) {
      const codeLower = (diag.icd10Code ?? "").toLowerCase();
      const descLower = diag.description.toLowerCase();

      const codeMatch =
        codeLower.length > 0 &&
        entry.conditionIcdPrefixes.some((prefix) => codeLower.startsWith(prefix.toLowerCase()));
      const keywordMatch = entry.conditionKeywords.some((kw) => descLower.includes(kw.toLowerCase()));

      if (codeMatch || keywordMatch) return entry;
    }
  }
  return null;
}
