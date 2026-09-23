// FOLLOW_UP_SUMMARY is trimmed to three sections — current treatment,
// pending investigations, follow-up plan — in both the standalone prompt and
// the consolidated bundle's followUp instructions.

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildConsolidatedSystemPrompt } from "@/prompts";
import { CAPABILITY_CONFIG } from "@/capabilities";

const KEPT = ["Current Treatment as Documented", "Pending Investigations", "Follow-up Plan as Documented"];
const REMOVED = ["Patient Profile", "Documented Diagnoses", "Documented Clinical Changes Since Previous Visit", "Recent Clinical Context"];

function consolidatedFollowUp(): string {
  const prompt = buildConsolidatedSystemPrompt();
  const start = prompt.indexOf("followUp (");
  return prompt.slice(start, prompt.indexOf("differentialDiagnosis (", start));
}

describe("FOLLOW_UP_SUMMARY prompt", () => {
  it.each([
    ["standalone", () => buildSystemPrompt("FOLLOW_UP_SUMMARY")],
    ["consolidated", consolidatedFollowUp],
  ])("%s prompt asks for only the three kept sections, in order", (_label, build) => {
    const text = build();
    const positions = KEPT.map((heading) => text.indexOf(`## ${heading}`));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const heading of REMOVED) expect(text).not.toContain(`## ${heading}`);
  });

  it("has a lowered token budget for the shorter output", () => {
    expect(CAPABILITY_CONFIG.FOLLOW_UP_SUMMARY.maxTokens).toBe(1000);
  });
});
