// GeminiProvider — only file in this project that imports @google/generative-ai.
//
// Security rules (same as AnthropicProvider):
//   - API key read from process.env only, never from a client-supplied argument.
//   - All Gemini SDK errors caught and normalized to AiProviderError with stable codes.
//   - Vendor error text is never forwarded to the caller.

import {
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIError,
} from "@google/generative-ai";
import { getGeminiApiKey, getAiModel, getAiTimeoutMs } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { AIProvider, AiRequest, AiResult, AiStreamEvent, AiUsage } from "./provider";
import { AiProviderError } from "./provider";

const HTTP_ERROR_CODES: Record<number, { code: string; retryable: boolean }> = {
  400: { code: "AI_BAD_REQUEST", retryable: false },
  401: { code: "AI_AUTH_FAILED", retryable: false },
  403: { code: "AI_FORBIDDEN", retryable: false },
  429: { code: "AI_RATE_LIMITED", retryable: true },
  500: { code: "AI_SERVER_ERROR", retryable: true },
  503: { code: "AI_UNAVAILABLE", retryable: true },
};

function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "STOP": return "end_turn";
    case "MAX_TOKENS": return "max_tokens";
    case "SAFETY": return "content_filtered";
    default: return reason ?? "end_turn";
  }
}

export class GeminiProvider implements AIProvider {
  readonly id = "gemini";
  readonly model: string;
  private readonly client: GoogleGenerativeAI | null;
  private readonly timeoutMs: number;

  constructor() {
    this.model = getAiModel();
    this.timeoutMs = getAiTimeoutMs();
    let key: string;
    try {
      key = getGeminiApiKey();
    } catch {
      this.client = null;
      return;
    }
    this.client = new GoogleGenerativeAI(key);
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete(req: AiRequest): Promise<AiResult> {
    if (!this.client) {
      throw new AiProviderError("AI_NOT_CONFIGURED", "Gemini API key not set");
    }

    const start = Date.now();
    const thinkingBudget = 8192;
    const effectiveMaxTokens = req.maxTokens + thinkingBudget;
    const geminiModel = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: req.systemPrompt,
      generationConfig: {
        maxOutputTokens: effectiveMaxTokens,
        temperature: req.temperature ?? 0.3,
        thinkingConfig: { thinkingBudget },
      } as Record<string, unknown>,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const result = await geminiModel.generateContent(
        {
          contents: req.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
        },
        { signal: controller.signal },
      );

      const text = result.response.text();
      const usage: AiUsage = {
        inputTokens: result.response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
      };
      const stopReason = mapFinishReason(
        result.response.candidates?.[0]?.finishReason as string | undefined,
      );

      logger.info("ai_complete_success", {
        provider: this.id,
        model: this.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - start,
      });

      return { text, model: this.model, provider: this.id, usage, stopReason };
    } catch (err) {
      this.handleError(err, start);
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(req: AiRequest): AsyncIterable<AiStreamEvent> {
    if (!this.client) {
      yield { type: "error", code: "AI_NOT_CONFIGURED", message: "Gemini API key not set" };
      return;
    }

    const start = Date.now();
    // gemini-3.6-flash is a thinking model: maxOutputTokens is shared between
    // internal reasoning and the final response. The model uses the majority of
    // the budget for thinking, so we need a much larger total budget.
    // thinkingBudget: 0 causes 400 for this model (cannot disable thinking).
    // Instead, cap thinking at 8192 tokens and give the response req.maxTokens.
    const thinkingBudget = 8192;
    const effectiveMaxTokens = req.maxTokens + thinkingBudget;
    const geminiModel = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: req.systemPrompt,
      generationConfig: {
        maxOutputTokens: effectiveMaxTokens,
        temperature: req.temperature ?? 0.3,
        thinkingConfig: { thinkingBudget },
      } as Record<string, unknown>,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const streamResult = await geminiModel.generateContentStream(
        {
          contents: req.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
        },
        { signal: controller.signal },
      );

      for await (const chunk of streamResult.stream) {
        const text = chunk.text();
        if (text) {
          yield { type: "text", text };
        }
      }

      clearTimeout(timer);

      const finalResponse = await streamResult.response;
      const thoughtsTokens = (finalResponse.usageMetadata as Record<string, unknown>)?.thoughtsTokenCount as number | undefined;
      const usage: AiUsage = {
        inputTokens: finalResponse.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: finalResponse.usageMetadata?.candidatesTokenCount ?? 0,
      };
      const stopReason = mapFinishReason(
        finalResponse.candidates?.[0]?.finishReason as string | undefined,
      );

      logger.info("ai_stream_success", {
        provider: this.id,
        model: this.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thoughtsTokens,
        durationMs: Date.now() - start,
      });

      yield { type: "done", model: this.model, provider: this.id, usage, stopReason };
    } catch (err) {
      clearTimeout(timer);
      const { code } = this.classifyError(err);
      logger.error("ai_stream_error", { code, durationMs: Date.now() - start });
      yield { type: "error", code, message: "AI stream failed" };
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private classifyError(err: unknown): { code: string; retryable: boolean } {
    if (err instanceof Error && err.name === "AbortError") {
      return { code: "AI_TIMEOUT", retryable: true };
    }
    if (err instanceof GoogleGenerativeAIFetchError) {
      return (err.status !== undefined && HTTP_ERROR_CODES[err.status]) ||
        { code: "AI_PROVIDER_ERROR", retryable: false };
    }
    if (err instanceof GoogleGenerativeAIError) {
      const msg = err.message?.toLowerCase() ?? "";
      if (msg.includes("timeout") || msg.includes("timed out")) {
        return { code: "AI_TIMEOUT", retryable: true };
      }
      if (msg.includes("network") || msg.includes("fetch")) {
        return { code: "AI_UNAVAILABLE", retryable: true };
      }
    }
    return { code: "AI_PROVIDER_ERROR", retryable: false };
  }

  private handleError(err: unknown, start: number): never {
    const { code, retryable } = this.classifyError(err);
    logger.error("ai_complete_error", { code, durationMs: Date.now() - start });
    throw new AiProviderError(code, "AI request failed", retryable);
  }
}
