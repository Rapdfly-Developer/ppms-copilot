// Copilot service pipeline.
//
// Shared by all API routes. Implements the full request-to-response pipeline:
//   1. Parse & validate request
//   2. Build patient context (calls PPMS Core APIs)
//   3. Build prompt
//   4. Check AI provider is configured
//   5. Stream AI response
//   6. Validate accumulated response
//   7. Emit NDJSON frames
//
// Security: patientRef and visitId come from the decoded token, never from the
// request body. The AI provider key is server-side only.

import { parseRequest } from "@/schemas/request";
import { buildPatientContext } from "@/context/builder";
import { buildSystemPrompt, buildUserMessage } from "@/prompts";
import { validateResponse, sanitiseResponse } from "@/validation/response";
import { createProvider } from "@/ai";
import { CAPABILITY_CONFIG } from "@/capabilities";
import { CopilotError, USER_MESSAGES, type ErrorCode } from "@/lib/errors";
import { logger } from "@/lib/logger";

// ── NDJSON frame types ────────────────────────────────────────────────────────

export type NdjsonFrame =
  | { type: "text"; text: string }
  | { type: "warning"; warnings: string[] }
  | { type: "done"; meta: Record<string, unknown> }
  | { type: "error"; code: string; message: string; discard: boolean };

// ── Pipeline ──────────────────────────────────────────────────────────────────

export async function* streamCopilotResponse(
  body: unknown,
  authorizationHeader: string | null,
): AsyncIterable<NdjsonFrame> {
  // 1. Parse & validate
  const parsed = parseRequest(body, authorizationHeader);
  if (!parsed.ok) {
    yield errorFrame(parsed.code, parsed.code as ErrorCode);
    return;
  }

  const { token, capability, patientRef, visitId, question } = parsed.data;
  const capConfig = CAPABILITY_CONFIG[capability];

  // 2. Build patient context (fetches from PPMS Core /api/v1/* endpoints)
  let context: Awaited<ReturnType<typeof buildPatientContext>>;
  try {
    context = await buildPatientContext({ token, capability, patientRef, visitId, question });
  } catch (err) {
    const code =
      err instanceof CopilotError ? err.code : ("INTERNAL_ERROR" as ErrorCode);
    logger.error("pipeline_context_failed", { capability, code });
    yield errorFrame(code, code);
    return;
  }

  // 3. Build prompts
  const systemPrompt = buildSystemPrompt(capability);
  const userMessage = buildUserMessage(context.text, capability, question);

  // 4. Check AI provider
  const provider = createProvider();
  if (!provider.isConfigured()) {
    logger.error("pipeline_provider_not_configured", { capability });
    yield errorFrame("AI_NOT_CONFIGURED", "AI_NOT_CONFIGURED");
    return;
  }

  // 5. Stream AI response
  let accumulatedText = "";
  let streamDone = false;
  let doneMeta: Record<string, unknown> = {};

  try {
    for await (const event of provider.stream({
      systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: capConfig.maxTokens,
      temperature: 0.3,
    })) {
      if (event.type === "text") {
        accumulatedText += event.text;
        yield { type: "text", text: event.text };
      } else if (event.type === "done") {
        streamDone = true;
        doneMeta = {
          model: event.model,
          provider: event.provider,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          stopReason: event.stopReason,
        };
      } else if (event.type === "error") {
        logger.error("pipeline_stream_error", { capability, code: event.code });
        yield errorFrame(event.code, event.code as ErrorCode);
        return;
      }
    }
  } catch {
    logger.error("pipeline_stream_exception", { capability });
    yield errorFrame("AI_UNAVAILABLE", "AI_UNAVAILABLE");
    return;
  }

  if (!streamDone) {
    yield errorFrame("INTERNAL_ERROR", "INTERNAL_ERROR");
    return;
  }

  // 6. Validate accumulated response
  const validation = validateResponse(
    accumulatedText,
    capability,
    doneMeta.stopReason as string | undefined,
  );

  if (!validation.ok) {
    logger.warn("pipeline_validation_failed", { capability, code: validation.code });
    yield errorFrame(validation.code, "RESPONSE_VALIDATION_FAILED");
    return;
  }

  // 7. Emit warnings (if any)
  if (validation.warnings.length > 0) {
    logger.info("pipeline_warnings", { capability, warningCount: validation.warnings.length });
    yield { type: "warning", warnings: validation.warnings };
  }

  // 8. Done
  logger.info("pipeline_complete", {
    capability,
    inputTokens: doneMeta.inputTokens as number,
    outputTokens: doneMeta.outputTokens as number,
    visitsIncluded: context.stats.visitsIncluded,
    estimatedTokens: context.stats.estimatedTokens,
  });

  yield {
    type: "done",
    meta: {
      ...doneMeta,
      capability,
      producesDraft: capConfig.producesDraft,
      draftType: capConfig.draftType,
      contextStats: context.stats,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errorFrame(rawCode: string, mappedCode: ErrorCode): NdjsonFrame {
  const message =
    USER_MESSAGES[mappedCode] ?? USER_MESSAGES.INTERNAL_ERROR;
  return { type: "error", code: rawCode, message, discard: true };
}
