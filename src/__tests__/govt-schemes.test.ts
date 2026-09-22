// matchGovtScheme — deterministic ICD-prefix/keyword matcher, same pattern
// as PPMS Core's own treatmentPresets.ts matchPresets(). No AI involvement —
// this is the ground truth PLAN_GUIDANCE's Govt Scheme block is verified
// against (see validation/response.ts's validatePlanGuidance).

import { describe, it, expect } from "vitest";
import { matchGovtScheme, GOVT_SCHEMES } from "@/lib/govt-schemes";

describe("matchGovtScheme", () => {
  it("matches by ICD-10 prefix", () => {
    const result = matchGovtScheme([
      { icd10Code: "H25.9", description: "Age-related cataract" },
    ]);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("ab-pmjay");
  });

  it("matches by keyword when no ICD code is documented", () => {
    const result = matchGovtScheme([{ icd10Code: undefined, description: "Cataract, left eye" } as never]);
    expect(result).not.toBeNull();
  });

  it("returns null when no diagnosis matches any table entry", () => {
    const result = matchGovtScheme([
      { icd10Code: "H40.11", description: "Primary open-angle glaucoma" },
    ]);
    expect(result).toBeNull();
  });

  it("returns null for an empty diagnosis list", () => {
    expect(matchGovtScheme([])).toBeNull();
  });

  it("returns the first matching table entry when multiple diagnoses could match different entries", () => {
    // Both GOVT_SCHEMES entries can match "cataract" — the function must
    // return exactly one entry (the first table entry that matches), not a
    // list, keeping the card to a single scheme reference.
    const result = matchGovtScheme([
      { icd10Code: "H25.9", description: "Age-related cataract" },
    ]);
    expect(result?.id).toBe(GOVT_SCHEMES[0].id);
  });

  it("never returns a partial or fabricated entry — only exact table objects", () => {
    const result = matchGovtScheme([
      { icd10Code: "H25.9", description: "Age-related cataract" },
    ]);
    expect(result).toBe(GOVT_SCHEMES.find((s) => s.id === result?.id));
  });
});
