// Consolidated Copilot generation service.
//
// Replaces 6 independent per-capability requests with a single AI call that
// generates all six MVP sections (snapshot, previousVisits, timeline, attention,
// draftNote, followUp) as a structured JSON response.
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
import { getCopilotReasoningModel } from "@/lib/env";
import { CopilotError, USER_MESSAGES, type ErrorCode } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { buildConsolidatedContext } from "@/context/builder";
import { buildConsolidatedSystemPrompt, buildConsolidatedUserMessage } from "@/prompts";
import type { Capability } from "@/capabilities";
import type { SectionOutcome, CopilotData } from "@/types/client";

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

const SECTION_CAPABILITIES: Record<keyof CopilotData, Capability> = {
  snapshot: "PATIENT_SNAPSHOT",
  previousVisits: "PREVIOUS_VISIT_SUMMARY",
  timeline: "TIMELINE_SUMMARY",
  attention: "IMPORTANT_CHANGES",
  draftNote: "NOTE_ASSISTANCE",
  followUp: "FOLLOW_UP_SUMMARY",
};

const SECTION_KEYS = Object.keys(SECTION_CAPABILITIES) as Array<keyof CopilotData>;

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

  // 2. Fetch all context once (union of all 6 capabilities' data needs)
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

  // 4. Single AI call — all six sections as structured JSON
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
      maxTokens: 5000,
      reasoningEffort: "high",
      modelOverride: model,
      responseFormat: "json_object",
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
    const code =
      err instanceof CopilotError ? err.code : ("AI_UNAVAILABLE" as ErrorCode);
    logger.error("generate_ai_failed", { requestId, code });
    return {
      ok: false,
      errorCode: code,
      errorMessage: USER_MESSAGES[code as ErrorCode] ?? USER_MESSAGES.AI_UNAVAILABLE,
      status: 503,
    };
  }

  // 5. Parse JSON response
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText) as Record<string, unknown>;
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
  const latencyMs = Date.now() - pipelineStart;
  const sections: Partial<CopilotData> = {};
  const sectionResults: Record<string, string> = {};

  for (const key of SECTION_KEYS) {
    const capability = SECTION_CAPABILITIES[key];
    const raw = parsed[key];

    if (typeof raw !== "string" || !raw.trim()) {
      sections[key] = errorSection("RESPONSE_EMPTY");
      sectionResults[key] = "empty";
      logger.warn("generate_section_empty", { requestId, section: key });
      continue;
    }

    const validation = validateResponse(raw, capability, doneMeta?.stopReason);
    if (!validation.ok) {
      sections[key] = errorSection(validation.code);
      sectionResults[key] = `validation_failed:${validation.code}`;
      logger.warn("generate_section_validation_failed", {
        requestId,
        section: key,
        code: validation.code,
      });
    } else {
      sections[key] = { ok: true, text: raw, warnings: validation.warnings };
      sectionResults[key] = validation.warnings.length > 0 ? "ok_with_warnings" : "ok";
    }
  }

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
    snapshot: sections.snapshot ?? errorSection("INTERNAL_ERROR"),
    previousVisits: sections.previousVisits ?? errorSection("INTERNAL_ERROR"),
    timeline: sections.timeline ?? errorSection("INTERNAL_ERROR"),
    attention: sections.attention ?? errorSection("INTERNAL_ERROR"),
    draftNote: sections.draftNote ?? errorSection("INTERNAL_ERROR"),
    followUp: sections.followUp ?? errorSection("INTERNAL_ERROR"),
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
