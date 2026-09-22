// Explicitly opt in: VI_GH_LIVE=1 npm test -- --run src/__tests__/vi-gh-live.test.ts
// Five calls only, entirely synthetic records; never prints environment secrets.
import { it, expect } from "vitest";
import { createProvider } from "@/ai";
import { CAPABILITY_CONFIG, type Capability } from "@/capabilities";
import { buildSystemPrompt, buildUserMessage } from "@/prompts";
import { validateResponse } from "@/validation/response";
import { getCopilotFastModel } from "@/lib/env";

it.skipIf(process.env.VI_GH_LIVE !== "1")("VI(g)/VI(h): five synthetic live sanity calls", async () => {
  process.loadEnvFile(".env.local");
  const provider = createProvider();
  const cases: [Capability, string][] = [
    ["DIAGNOSIS_COMPARISON", "V0: Gradual painless blurred vision. Lens opacity documented. Diagnosis: cataract."],
    ["DIAGNOSIS_COMPARISON", "V0: Intermittent blurred vision, provisional dry eye diagnosis. Findings: mild tear-film instability; the documented findings do not rule out other causes. No additional examination documented."],
    ["DIAGNOSIS_COMPARISON", "V0: Blurred vision documented. No diagnosis documented for this visit."],
    ["LAST_VISIT_SUMMARY", "Visit V1 (2026-08-01): Chief complaint: blurred vision. Findings: lens opacity. Diagnosis: cataract. Medications: none documented. Plan: return in one month."],
    ["LAST_VISIT_SUMMARY", "No previous visit documented."],
  ];
  const failures: string[] = [];
  for (const [capability, context] of (process.env.VI_GH_RETEST === "1" ? cases.slice(0, 1) : cases)) {
    const config = CAPABILITY_CONFIG[capability];
    const response = await provider.complete({
      systemPrompt: buildSystemPrompt(capability),
      messages: [{ role: "user", content: buildUserMessage(context, capability) }],
      modelOverride: getCopilotFastModel(), reasoningEffort: "medium", maxTokens: config.maxTokens,
    });
    const validation = validateResponse(response.text, capability, response.stopReason);
    console.log(JSON.stringify({ capability, model: response.model, stopReason: response.stopReason, validation, text: response.text }));
    if (!validation.ok) failures.push(`${capability}: ${validation.code}`);
    if (context === "No previous visit documented." && response.text.trim() !== "No previous visit documented — this is the first recorded visit for this patient.") failures.push("Incorrect first-visit fallback");
  }
  expect(failures).toEqual([]);
}, 300000);
