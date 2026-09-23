import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateResponse } from "@/validation/response";
import { generateCopilot } from "@/service/copilot-generate";
import { setProvider, resetProvider } from "@/ai";
import { CAPABILITY_CONFIG } from "@/capabilities";
import { getCopilotFastModel, getCopilotReasoningModel } from "@/lib/env";
import { decideAssessmentUpdate } from "@/lib/assessment-update";
import { decidePatientProfileUpdate } from "@/lib/patient-profile-update";
import * as ppms from "@/lib/ppms-client";
import type { AIProvider, AiRequest } from "@/ai/provider";
import { FIXTURE_PATIENT, FIXTURE_VISIT_CURRENT, FIXTURE_VISIT_PREVIOUS, FIXTURE_TOKEN } from "./fixtures/patient";

const plausible = "[Plausibility]\nAssessment: Plausible\nReason: Documented blurred vision is consistent with the documented cataract.";
const omitted = "[Plausibility]\nNot applicable — no documented diagnosis for this visit.";
const reason = "Documented blurred vision\nis consistent with lens opacity.";
const ddx = `**Cataract**\n${reason}\nConfidence: Moderate\nSource: V0`;
const emptyDdx = "The documented record does not contain sufficient findings to support any diagnostic considerations at this time.";
const summary = "## Visit Summary (V1)\n- **Chief complaint:** Previous blurred vision documented.";

describe("Plausibility validator", () => {
  it.each(["Plausible", "Worth reviewing"])("accepts %s", (label) => {
    expect(validateResponse(plausible.replace("Assessment: Plausible", `Assessment: ${label}`), "DIAGNOSIS_COMPARISON").ok).toBe(true);
  });
  it("accepts the exact omission without inventing a result", () => {
    expect(validateResponse(omitted, "DIAGNOSIS_COMPARISON")).toMatchObject({ ok: true, diagnosisComparisonResult: {} });
  });
  it("allows descriptive rule out only in this scoped capability", () => {
    const text = "[Plausibility]\nAssessment: Worth reviewing\nReason: The documented findings do not rule out an alternative diagnosis.";
    expect(validateResponse(text, "DIAGNOSIS_COMPARISON").ok).toBe(true);
    expect(validateResponse(text, "EXAM_GUIDANCE")).toMatchObject({ ok: false, code: "RESPONSE_UNSAFE" });
  });
  it.each(["incorrect", "wrong", "should be", "misdiagnosed", "should have been", "is actually", "mistaken", "Check", "Examine", "Order", "Evaluate"])("rejects %s", (word) => {
    expect(validateResponse(plausible + ` ${word}`, "DIAGNOSIS_COMPARISON")).toMatchObject({ ok: false, code: "RESPONSE_UNSAFE" });
  });
  it.each([plausible.replace("Assessment: Plausible", "Assessment: Correct"), plausible + "\nExtra content", omitted + "\n" + plausible, plausible.replace("Reason:", "Comment:")])("rejects malformed output", (text) => {
    expect(validateResponse(text, "DIAGNOSIS_COMPARISON").ok).toBe(false);
  });
  it("rejects truncation", () => {
    expect(validateResponse(plausible, "DIAGNOSIS_COMPARISON", "max_tokens")).toMatchObject({ ok: false, code: "RESPONSE_TRUNCATED" });
  });
  it("does not paraphrase DDx reasons during shared pre-sanitisation", () => {
    const original = "I suggest considering the documented lens opacity as a correlation.";
    const result = validateResponse(`**Cataract**\n${original}\nConfidence: Low`, "DIFFERENTIAL_DIAGNOSIS");
    expect(result).toMatchObject({ ok: true, differentialReasonCitations: [{ name: "Cataract", reason: original }] });
  });
  it("captures DDx reasons while leaving the existing public item contract unchanged", () => {
    const result = validateResponse(ddx, "DIFFERENTIAL_DIAGNOSIS");
    expect(result).toMatchObject({ ok: true, differentialReasonCitations: [{ name: "Cataract", reason }] });
    if (result.ok) expect(result.differentialDiagnosisItems).toEqual([{ name: "Cataract", confidence: "Moderate", source: "V0" }]);
  });
});

beforeEach(() => {
  vi.spyOn(ppms, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
  vi.spyOn(ppms, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
  vi.spyOn(ppms, "getVisits").mockResolvedValue([FIXTURE_VISIT_PREVIOUS]);
  vi.spyOn(ppms, "getAppointments").mockResolvedValue([]);
  vi.spyOn(ppms, "getTimeline").mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); resetProvider(); });

// The consolidated bundle is the only call whose system prompt carries the
// shared JSON output spec — it no longer sends responseFormat.
const isBundle = (request: AiRequest) => request.systemPrompt.includes("OUTPUT FORMAT REQUIREMENT");

function provider(comparison = plausible, differential = ddx, failSummary = false) {
  const calls: AiRequest[] = [];
  const mock: AIProvider = {
    id: "mock", model: "mock", isConfigured: () => true,
    async complete(request) {
      calls.push(request);
      const text = isBundle(request) ? JSON.stringify({
        differentialDiagnosis: differential,
        assessmentContext: "The documented diagnoses are recorded for clinician review.",
        snapshot: "The patient has documented clinical history.",
        previousVisits: "Prior visits document the clinical history.",
      }) : request.systemPrompt.includes("[Plausibility]") ? comparison : failSummary ? "" : summary;
      return { text, model: request.modelOverride!, provider: "mock", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
    async *stream() { throw new Error("Not used"); },
  };
  setProvider(mock);
  return calls;
}

describe("VI(g)/VI(h) eager generation integration", () => {
  it("uses fast/medium in actual requests and threads same-generation verbatim citations into the message", async () => {
    const calls = provider();
    const result = await generateCopilot(`Bearer ${FIXTURE_TOKEN}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(3);
    expect(calls.filter(isBundle).map((call) => call.modelOverride)).toEqual([getCopilotReasoningModel()]);
    for (const call of calls.filter((call) => !isBundle(call))) {
      expect(call.modelOverride).toBe(getCopilotFastModel());
      expect(call.reasoningEffort).toBe("medium");
    }
    expect(getCopilotFastModel()).not.toBe(getCopilotReasoningModel());
    expect(CAPABILITY_CONFIG.DIAGNOSIS_COMPARISON.modelTier).toBe("fast");
    const section = result.data.diagnosisComparison;
    expect(section).toMatchObject({ ok: true, diagnosisComparisonResult: {
      plausibility: { assessment: "Plausible" }, differentialDiagnosisReasoning: [{ name: "Cataract", reason }],
    } });
    const state = { status: "done" as const, data: result.data, meta: result.meta };
    const decision = decideAssessmentUpdate(state, null);
    expect(decision).toMatchObject({ send: true, diagnosisComparison: { differentialDiagnosisReasoning: [{ name: "Cataract", reason }] } });
    expect(decideAssessmentUpdate(state, result.meta.requestId)).toEqual({ send: false });
    expect(decideAssessmentUpdate({ ...state, meta: { requestId: "regenerated" } }, result.meta.requestId).send).toBe(true);
    expect(result.meta.inputTokens).toBe(3);
  });
  it.each([emptyDdx, "Malformed differential response"])("keeps Plausibility without DDx citations", async (differential) => {
    provider(plausible, differential);
    const result = await generateCopilot(`Bearer ${FIXTURE_TOKEN}`);
    if (!result.ok) throw new Error("Generation failed");
    const section = result.data.diagnosisComparison;
    if (!section.ok) throw new Error("Comparison failed");
    expect(section.diagnosisComparisonResult?.plausibility).toBeDefined();
    expect(section.diagnosisComparisonResult?.differentialDiagnosisReasoning).toBeUndefined();
  });
  it("keeps DDx citations with no documented diagnosis and suppresses hallucinated plausibility", async () => {
    vi.mocked(ppms.getVisit).mockResolvedValue({ ...FIXTURE_VISIT_CURRENT, diagnoses: [] });
    provider();
    const result = await generateCopilot(`Bearer ${FIXTURE_TOKEN}`);
    if (!result.ok) throw new Error("Generation failed");
    expect(result.data.diagnosisComparison).toMatchObject({ ok: true, diagnosisComparisonResult: { differentialDiagnosisReasoning: [{ name: "Cataract", reason }] } });
    if (result.data.diagnosisComparison.ok) expect(result.data.diagnosisComparison.diagnosisComparisonResult?.plausibility).toBeUndefined();
  });
  it("never sends a failed comparison, preserving existing assessment context", async () => {
    provider("The documented diagnosis is wrong.");
    const result = await generateCopilot(`Bearer ${FIXTURE_TOKEN}`);
    if (!result.ok) throw new Error("Generation failed");
    expect(result.data.diagnosisComparison.ok).toBe(false);
    const decision = decideAssessmentUpdate({ status: "done", data: result.data, meta: result.meta }, null);
    expect(decision.send).toBe(true);
    expect(decision).not.toHaveProperty("diagnosisComparison");
  });
  it("sends only the newest prior visit to LAST_VISIT_SUMMARY, excluding current/older visits", async () => {
    vi.mocked(ppms.getVisit).mockResolvedValue({ ...FIXTURE_VISIT_CURRENT, chiefComplaint: "CURRENT_SENTINEL" });
    vi.mocked(ppms.getVisits).mockResolvedValue([
      { ...FIXTURE_VISIT_PREVIOUS, visitId: "older", date: "2023-01-01", chiefComplaint: "OLDER_SENTINEL" },
      { ...FIXTURE_VISIT_CURRENT, chiefComplaint: "CURRENT_SENTINEL" },
      { ...FIXTURE_VISIT_PREVIOUS, date: "2024-01-01", chiefComplaint: "V1_SENTINEL" },
    ]);
    const calls = provider();
    const result = await generateCopilot(`Bearer ${FIXTURE_TOKEN}`);
    const call = calls.find((request) => request.systemPrompt.includes("Visit Summary (V1"))!;
    expect(call.messages[0].content).toContain("V1_SENTINEL");
    expect(call.messages[0].content).not.toMatch(/CURRENT_SENTINEL|OLDER_SENTINEL/);
    if (!result.ok) throw new Error("Generation failed");
    const decision = decidePatientProfileUpdate({ status: "done", data: result.data, meta: result.meta }, null);
    expect(decision).toMatchObject({ send: true, lastVisitSummary: summary });
    expect(decision).not.toHaveProperty("timelineSummary");
  });
  it("provides explicit no-prior-visit context", async () => {
    vi.mocked(ppms.getVisits).mockResolvedValue([FIXTURE_VISIT_CURRENT]);
    const calls = provider();
    await generateCopilot(`Bearer ${FIXTURE_TOKEN}`);
    const call = calls.find((request) => request.systemPrompt.includes("Visit Summary (V1"))!;
    expect(call.messages[0].content).toContain("No previous visit documented.");
  });
  it("isolates a failed last-visit summary from the other profile fields", async () => {
    provider(plausible, ddx, true);
    const result = await generateCopilot(`Bearer ${FIXTURE_TOKEN}`);
    if (!result.ok) throw new Error("Generation failed");
    const decision = decidePatientProfileUpdate({ status: "done", data: result.data, meta: result.meta }, null);
    expect(decision).toMatchObject({ send: true, patientSnapshot: expect.any(String), previousVisitSummary: expect.any(String) });
    expect(decision).not.toHaveProperty("lastVisitSummary");
  });
});
