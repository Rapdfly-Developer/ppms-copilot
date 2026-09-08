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

function isThinkingModel(model: string): boolean {
  return model.includes("2.5") || model.includes("thinking");
}

const HTTP_ERROR_CODES: Record<number, { code: string; retryable: boolean }> = {
  400: { code: "AI_UNAVAILABLE", retryable: false },
  401: { code: "AI_AUTH_FAILED", retryable: false },
  403: { code: "AI_AUTH_FAILED", retryable: false },
  404: { code: "AI_NOT_CONFIGURED", retryable: false },
  429: { code: "AI_RATE_LIMITED", retryable: true },
  500: { code: "AI_UNAVAILABLE", retryable: true },
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
    const thinking = isThinkingModel(this.model);
    const thinkingBudget = thinking ? 8192 : 0;
    const effectiveMaxTokens = req.maxTokens + thinkingBudget;
    const geminiModel = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: req.systemPrompt,
      generationConfig: {
        maxOutputTokens: effectiveMaxTokens,
        temperature: req.temperature ?? 0.3,
        ...(thinking && { thinkingConfig: { thinkingBudget } }),
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
    const thinking = isThinkingModel(this.model);
    const thinkingBudget = thinking ? 8192 : 0;
    const effectiveMaxTokens = req.maxTokens + thinkingBudget;
    const geminiModel = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: req.systemPrompt,
      generationConfig: {
        maxOutputTokens: effectiveMaxTokens,
        temperature: req.temperature ?? 0.3,
        ...(thinking && { thinkingConfig: { thinkingBudget } }),
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
      const thoughtsTokens = (finalResponse.usageMetadata as unknown as Record<string, unknown>)?.thoughtsTokenCount as number | undefined;
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
        ...(thoughtsTokens !== undefined && { thoughtsTokens }),
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
      logger.error("gemini_http_error", { status: err.status, model: this.model, errorMessage: err.message });
      return (err.status !== undefined && HTTP_ERROR_CODES[err.status]) ||
        { code: "AI_UNAVAILABLE", retryable: false };
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
    return { code: "AI_UNAVAILABLE", retryable: false };
  }

  private handleError(err: unknown, start: number): never {
    const { code, retryable } = this.classifyError(err);
    logger.error("ai_complete_error", { code, durationMs: Date.now() - start });
    throw new AiProviderError(code, "AI request failed", retryable);
  }
}
