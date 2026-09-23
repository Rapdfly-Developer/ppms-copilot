// Consolidated Copilot generation service.
//
// Replaces independent per-capability requests with a single AI call that
// generates eleven sections (timeline, attention, draftNote, followUp,
// differentialDiagnosis, medications, investigations, assessmentContext,
// suggestedQuestions, planGuidance, investigationGuidance) as a structured
// JSON response, using the reasoning-tier model. PATIENT_SNAPSHOT and
// PREVIOUS_VISIT_SUMMARY are not bundled: nothing in the Copilot renders them. EXAM_GUIDANCE and REFRACTIVE_GUIDANCE are NOT part of
// this bundle — both are on-demand only, triggered from PPMS Core via their
// own /api/copilot/stream requests (see CopilotApp.tsx's dedicated
// useCopilotStream instances), since their source tabs are often empty at
// visit-open. PLAN_GUIDANCE and INVESTIGATION_GUIDANCE ARE part of this
// bundle — their inputs (diagnoses, medications, pre-computed CLINICAL
// EVIDENCE deltas, documented investigations) are already fetched for the
// other sections regardless, so there's no equivalent empty-at-visit-open risk.
//
// DIAGNOSIS_COMPARISON is eager too, but is NOT part of the single JSON
// bundle above — opening a visit costs the one bundled call PLUS this one,
// issued immediately after. It's split out because it must run at the
// fast/medium tier (an explicit product decision — a narrow single-field
// judgment doesn't need open-ended reasoning depth), and the bundle is one
// provider.complete() call with one shared model/reasoningEffort for every
// key in it. It also gets its own narrower, current-visit-only context text
// (context.diagnosisComparisonText in context/builder.ts), so it cannot see
// investigation results it isn't meant to reason from. Net effect: 2 real AI
// calls per visit open (1 bundle + 1 comparison).
//
// Security invariants:
//   - patientRef and visitId come from the decoded token ONLY — never from body.
//   - Authorization is enforced by every PPMS Core API call (token verified there).
//   - Patient context is fetched once; no data is repeated in the prompt.
//   - Response headers include Cache-Control: no-store, private.
//
// Clinical safety:
//   - validateResponse() runs on each section individually.
//   - A single failed section does not discard valid sections.
//   - Draft sections still require explicit doctor confirmation before entering EMR.

import { validateResponse } from "@/validation/response";
import { createProvider } from "@/ai";
import { AiProviderError } from "@/ai/provider";
import { getCopilotReasoningModel, getCopilotFastModel } from "@/lib/env";
import { CopilotError, USER_MESSAGES, type ErrorCode } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { buildConsolidatedContext } from "@/context/builder";
import { buildSystemPrompt, buildUserMessage, buildConsolidatedSystemPrompt, buildConsolidatedUserMessage } from "@/prompts";
import { CAPABILITY_CONFIG, type Capability } from "@/capabilities";
import type { DifferentialReasonCitation, SectionOutcome, CopilotData } from "@/types/client";

// ── Token decoder ─────────────────────────────────────────────────────────────
// Mirrors the logic in src/schemas/request.ts — no verification here, PPMS Core
// verifies the HMAC on every /api/v1/* call that uses this token.

type TokenRouting = { token: string; patientRef: string; visitId: string };

function decodeToken(authorizationHeader: string | null): TokenRouting | null {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice(7).trim();
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const { patientRef, visitId, exp } = payload;
    if (typeof patientRef !== "string" || !patientRef) return null;
    if (typeof visitId !== "string" || !visitId) return null;
    if (typeof exp !== "number" || Math.floor(Date.now() / 1000) > exp) return null;
    return { token, patientRef, visitId };
  } catch {
    return null;
  }
}

// ── Section validation ────────────────────────────────────────────────────────

const SECTION_CAPABILITIES: Record<Exclude<keyof CopilotData, "diagnosisComparison">, Capability> = {
  timeline: "TIMELINE_SUMMARY",
  attention: "IMPORTANT_CHANGES",
  draftNote: "NOTE_ASSISTANCE",
  followUp: "FOLLOW_UP_SUMMARY",
  differentialDiagnosis: "DIFFERENTIAL_DIAGNOSIS",
  medications: "MEDICATIONS_SUMMARY",
  investigations: "INVESTIGATIONS_SUMMARY",
  assessmentContext: "ASSESSMENT_CONTEXT",
  suggestedQuestions: "SUGGESTED_QUESTIONS",
  planGuidance: "PLAN_GUIDANCE",
  investigationGuidance: "INVESTIGATION_GUIDANCE",
};

const SECTION_KEYS = Object.keys(SECTION_CAPABILITIES) as Array<keyof typeof SECTION_CAPABILITIES>;

function errorSection(code: string): SectionOutcome {
  const errorMessage =
    USER_MESSAGES[code as ErrorCode] ?? USER_MESSAGES.INTERNAL_ERROR;
  return { ok: false, errorCode: code, errorMessage };
}

// ── Response types ────────────────────────────────────────────────────────────

export type GenerateMeta = {
  requestId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  latencyMs: number;
  visitsIncluded: number;
  estimatedTokens: number;
};

export type GenerateResponse =
  | { ok: true; data: CopilotData; meta: GenerateMeta }
  | { ok: false; errorCode: string; errorMessage: string; status: number };

// ── Main service ──────────────────────────────────────────────────────────────

export async function generateCopilot(
  authorizationHeader: string | null,
): Promise<GenerateResponse> {
  const pipelineStart = Date.now();
  const requestId = Math.random().toString(36).slice(2, 10);

  // 1. Decode token — patientRef and visitId come only from here
  const routing = decodeToken(authorizationHeader);
  if (!routing) {
    return {
      ok: false,
      errorCode: "TOKEN_INVALID",
      errorMessage: USER_MESSAGES.TOKEN_INVALID,
      status: 401,
    };
  }
  const { token, patientRef, visitId } = routing;

  // 2. Fetch all context once (union of all consolidated capabilities' data needs)
  let context: Awaited<ReturnType<typeof buildConsolidatedContext>>;
  try {
    context = await buildConsolidatedContext({ token, patientRef, visitId });
  } catch (err) {
    const code =
      err instanceof CopilotError ? err.code : ("INTERNAL_ERROR" as ErrorCode);
    logger.error("generate_context_failed", { requestId, code });
    return {
      ok: false,
      errorCode: code,
      errorMessage: USER_MESSAGES[code as ErrorCode] ?? USER_MESSAGES.INTERNAL_ERROR,
      status: 500,
    };
  }

  // 3. Check AI provider
  const provider = createProvider();
  if (!provider.isConfigured()) {
    logger.error("generate_provider_not_configured", { requestId });
    return {
      ok: false,
      errorCode: "AI_NOT_CONFIGURED",
      errorMessage: USER_MESSAGES.AI_NOT_CONFIGURED,
      status: 503,
    };
  }

  const model = getCopilotReasoningModel();

  logger.info("generate_request_start", {
    requestId,
    model,
    estimatedTokens: context.stats.estimatedTokens,
    visitsIncluded: context.stats.visitsIncluded,
  });

  // 4. Single AI call — all eleven bundled sections as structured JSON
  const systemPrompt = buildConsolidatedSystemPrompt();
  const userMessage = buildConsolidatedUserMessage(context.text);

  let rawText = "";
  let doneMeta: {
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    stopReason: string;
  } | null = null;

  try {
    const result = await provider.complete({
      systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      // 12800: was 11000, bumped for INVESTIGATION_GUIDANCE joining as the
      // 13th section (own per-capability budget: 1800 — live-tested; 1400
      // truncated on a real verbose response, see capabilities/index.ts). A
      // truncated JSON response fails to parse for ALL sections, not just
      // whichever key comes last, so every section added here must also
      // grow this shared cap — provisional, live-test before treating as final.
      //
      // 11000 (prior value): was 10000, bumped for PLAN_GUIDANCE joining as
      // the 12th section (own per-capability budget: 1400, matched to
      // EXAM_GUIDANCE's).
      //
      // 10000 (value before that): was 6000, which proved too tight for
      // openai/gpt-oss-120b — live testing produced a Groq-side "Failed to
      // generate JSON" error at that cap (the model overran it and the
      // response was cut off mid-JSON, making the whole thing unparseable).
      // Sized with real headroom above the pre-consolidation per-capability
      // sum (700+1000+1200+1400+1400+1400+1400 = 8500, tuned for the old,
      // less verbose Llama defaults) to absorb this model's more verbose style.
      maxTokens: 12800,
      reasoningEffort: "medium",
      modelOverride: model,
      // No responseFormat: openai/gpt-oss-120b is a reasoning model and does
      // not support json_object mode — sending it causes a 400. The system
      // prompt already mandates "Return ONLY the JSON object" which is
      // sufficient; extractJSON() below strips any code-fence wrapping just
      // in case the model adds it anyway.
    });
    rawText = result.text;
    doneMeta = {
      model: result.model,
      provider: result.provider,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      stopReason: result.stopReason,
    };
  } catch (err) {
    // Provider failures (Groq/Anthropic) throw AiProviderError, not
    // CopilotError — these are two separate class hierarchies (AiProviderError
    // lives in @/ai/provider, CopilotError in @/lib/errors). Checking only
    // `instanceof CopilotError` here meant this branch never matched a real
    // provider failure, so every AI-call error — rate limit, auth failure,
    // timeout, bad request — silently collapsed to the generic AI_UNAVAILABLE
    // fallback, discarding the specific, more actionable code the provider
    // layer had already classified (e.g. AI_RATE_LIMITED).
    const code: ErrorCode =
      err instanceof AiProviderError
        ? (err.code as ErrorCode)
        : err instanceof CopilotError
          ? err.code
          : ("AI_UNAVAILABLE" as ErrorCode);
    logger.error("generate_ai_failed", { requestId, code });
    return {
      ok: false,
      errorCode: code,
      errorMessage: USER_MESSAGES[code as ErrorCode] ?? USER_MESSAGES.AI_UNAVAILABLE,
      status: 503,
    };
  }

  // 5. Parse JSON response
  // extractJSON: strip ```json ... ``` code fences that reasoning models
  // sometimes add despite the "no code fence" instruction.
  function extractJSON(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) return text.slice(start, end + 1);
    return text.trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJSON(rawText)) as Record<string, unknown>;
  } catch {
    logger.error("generate_json_parse_failed", {
      requestId,
      preview: rawText.slice(0, 120),
    });
    return {
      ok: false,
      errorCode: "INTERNAL_ERROR",
      errorMessage: USER_MESSAGES.INTERNAL_ERROR,
      status: 500,
    };
  }

  // 6. Validate each section individually — a single failure does not discard others
  let latencyMs = Date.now() - pipelineStart;
  const sections: Partial<CopilotData> = {};
  const sectionResults: Record<string, string> = {};
  let differentialReasons: DifferentialReasonCitation[] = [];

  for (const key of SECTION_KEYS) {
    const capability = SECTION_CAPABILITIES[key];
    const raw = parsed[key];

    if (typeof raw !== "string" || !raw.trim()) {
      sections[key] = errorSection("RESPONSE_EMPTY");
      sectionResults[key] = "empty";
      logger.warn("generate_section_empty", { requestId, section: key });
      continue;
    }

    // groundTruth.matchedScheme is only read by PLAN_GUIDANCE's validator —
    // harmless to pass for every other capability, which ignores it.
    const validation = validateResponse(raw, capability, doneMeta?.stopReason, {
      matchedScheme: context.matchedGovtScheme,
    });
    if (!validation.ok) {
      sections[key] = errorSection(validation.code);
      sectionResults[key] = `validation_failed:${validation.code}`;
      logger.warn("generate_section_validation_failed", {
        requestId,
        section: key,
        code: validation.code,
      });
    } else {
      // Some models double-escape newlines inside json_object responses, emitting
      // literal \n (two chars) instead of a real newline. Normalise before storing.
      if (key === "differentialDiagnosis") differentialReasons = validation.differentialReasonCitations ?? [];
      const normalised = raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      sections[key] = {
        ok: true,
        text: normalised,
        warnings: validation.warnings,
        ...(validation.differentialDiagnosisItems
          ? { differentialDiagnosisItems: validation.differentialDiagnosisItems }
          : {}),
        ...(validation.planGuidanceResult
          ? { planGuidanceResult: validation.planGuidanceResult }
          : {}),
        ...(validation.investigationGuidanceResult
          ? { investigationGuidanceResult: validation.investigationGuidanceResult }
          : {}),
      };
      sectionResults[key] = validation.warnings.length > 0 ? "ok_with_warnings" : "ok";
    }
  }

  // DIAGNOSIS_COMPARISON runs on the fast model, independently of the
  // reasoning-tier bundle, from the already-fetched current-visit DTO.
  // A failure here stays local to this section.
  await Promise.all(([
    ["diagnosisComparison", "DIAGNOSIS_COMPARISON", context.diagnosisComparisonText],
  ] as const).map(async ([key, capability, scopedContext]) => {
    try {
      const config = CAPABILITY_CONFIG[capability];
      const response = await provider.complete({
        systemPrompt: buildSystemPrompt(capability),
        messages: [{ role: "user", content: buildUserMessage(scopedContext ?? "No record documented.", capability) }],
        modelOverride: getCopilotFastModel(), reasoningEffort: config.reasoningEffort,
        maxTokens: config.maxTokens,
      });
      // Include the auxiliary calls in usage totals, not just the large bundle.
      if (doneMeta) {
        doneMeta.inputTokens += response.usage.inputTokens;
        doneMeta.outputTokens += response.usage.outputTokens;
      }
      const validation = validateResponse(response.text, capability, response.stopReason);
      if (!validation.ok) {
        sections[key] = errorSection(validation.code);
        sectionResults[key] = `validation_failed:${validation.code}`;
        return;
      }
      sectionResults[key] = "ok";
      sections[key] = { ok: true, text: response.text, warnings: validation.warnings,
        ...(validation.diagnosisComparisonResult ? { diagnosisComparisonResult: validation.diagnosisComparisonResult } : {}),
      };
    } catch (error) {
      sections[key] = errorSection(error instanceof AiProviderError ? error.code : "AI_UNAVAILABLE");
      sectionResults[key] = "provider_failed";
    }
  }));

  const comparison = sections.diagnosisComparison;
  if (comparison?.ok && comparison.diagnosisComparisonResult) {
    const plausibility = context.hasDocumentedDiagnosis
      ? comparison.diagnosisComparisonResult.plausibility : undefined;
    const citations = sections.differentialDiagnosis?.ok && differentialReasons.length
      ? differentialReasons : undefined;
    sections.diagnosisComparison = {
      ...comparison,
      text: [plausibility
        ? `[Plausibility]\nAssessment: ${plausibility.assessment}\nReason: ${plausibility.reason}`
        : "[Plausibility]\nNot applicable — no documented diagnosis for this visit.",
        citations ? "[Differential Diagnosis Reasoning]\n" + citations.map((item) => `- ${item.name}: ${item.reason}`).join("\n") : "",
      ].filter(Boolean).join("\n\n"),
      diagnosisComparisonResult: {
        ...(plausibility ? { plausibility } : {}),
        ...(citations ? { differentialDiagnosisReasoning: citations } : {}),
      },
    };
  }

  // Thread the already-validated FOLLOW_UP_SUMMARY text into planGuidance's
  // result — the exact same content the Follow-up tab already shows,
  // referenced a second time inside the Plan Guidance card. No new AI call,
  // no new validation: this runs after both sections are independently
  // resolved above, so it doesn't depend on SECTION_KEYS iteration order.
  // Absent (not an error) when followUp itself failed or was empty —
  // Plan Guidance's other sections are entirely unaffected either way.
  const followUpSection = sections.followUp;
  const planGuidanceSection = sections.planGuidance;
  if (followUpSection?.ok && planGuidanceSection?.ok && planGuidanceSection.planGuidanceResult) {
    sections.planGuidance = {
      ...planGuidanceSection,
      planGuidanceResult: {
        ...planGuidanceSection.planGuidanceResult,
        followUpSummary: followUpSection.text,
      },
    };
  }

  // Thread the already-validated INVESTIGATIONS_SUMMARY text into
  // investigationGuidance's result — same pure-reuse reasoning as
  // followUpSummary above. No new AI call, no new validation. Absent (not
  // an error) when investigations itself failed or was empty —
  // investigationGuidance's own suggestedInvestigations list is entirely
  // unaffected either way.
  const investigationsSection = sections.investigations;
  const investigationGuidanceSection = sections.investigationGuidance;
  if (
    investigationsSection?.ok &&
    investigationGuidanceSection?.ok &&
    investigationGuidanceSection.investigationGuidanceResult
  ) {
    sections.investigationGuidance = {
      ...investigationGuidanceSection,
      investigationGuidanceResult: {
        ...investigationGuidanceSection.investigationGuidanceResult,
        investigationsSummary: investigationsSection.text,
      },
    };
  }

  latencyMs = Date.now() - pipelineStart;
  logger.info("generate_complete", {
    requestId,
    model: doneMeta?.model,
    provider: doneMeta?.provider,
    inputTokens: doneMeta?.inputTokens,
    outputTokens: doneMeta?.outputTokens,
    visitsIncluded: context.stats.visitsIncluded,
    estimatedTokens: context.stats.estimatedTokens,
    latencyMs,
    sectionResults,
  });

  const data: CopilotData = {
    timeline: sections.timeline ?? errorSection("INTERNAL_ERROR"),
    attention: sections.attention ?? errorSection("INTERNAL_ERROR"),
    draftNote: sections.draftNote ?? errorSection("INTERNAL_ERROR"),
    followUp: sections.followUp ?? errorSection("INTERNAL_ERROR"),
    differentialDiagnosis: sections.differentialDiagnosis ?? errorSection("INTERNAL_ERROR"),
    medications: sections.medications ?? errorSection("INTERNAL_ERROR"),
    investigations: sections.investigations ?? errorSection("INTERNAL_ERROR"),
    assessmentContext: sections.assessmentContext ?? errorSection("INTERNAL_ERROR"),
    suggestedQuestions: sections.suggestedQuestions ?? errorSection("INTERNAL_ERROR"),
    planGuidance: sections.planGuidance ?? errorSection("INTERNAL_ERROR"),
    investigationGuidance: sections.investigationGuidance ?? errorSection("INTERNAL_ERROR"),
    diagnosisComparison: sections.diagnosisComparison ?? errorSection("INTERNAL_ERROR"),
  };

  const meta: GenerateMeta = {
    requestId,
    model: doneMeta?.model ?? "",
    provider: doneMeta?.provider ?? "",
    inputTokens: doneMeta?.inputTokens ?? 0,
    outputTokens: doneMeta?.outputTokens ?? 0,
    stopReason: doneMeta?.stopReason ?? "",
    latencyMs,
    visitsIncluded: context.stats.visitsIncluded,
    estimatedTokens: context.stats.estimatedTokens,
  };

  return { ok: true, data, meta };
}
