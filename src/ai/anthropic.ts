// AnthropicProvider — the only file in this project that imports @anthropic-ai/sdk.
//
// Security rules enforced here:
//   - API key is read from process.env — never from a constructor argument
//     supplied by the client side.
//   - All Anthropic SDK errors are caught and normalized to AiProviderError
//     with a stable code. No vendor error text (which may contain echoed
//     request content) is forwarded to the caller.
//   - Hard timeout per request — no runaway requests.

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicApiKey, getAiModel, getAiTimeoutMs } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { AIProvider, AiRequest, AiResult, AiStreamEvent, AiUsage } from "./provider";
import { AiProviderError } from "./provider";

// Map Anthropic HTTP status → stable error code
const HTTP_ERROR_CODES: Record<number, { code: string; retryable: boolean }> = {
  400: { code: "AI_BAD_REQUEST", retryable: false },
  401: { code: "AI_AUTH_FAILED", retryable: false },
  403: { code: "AI_FORBIDDEN", retryable: false },
  429: { code: "AI_RATE_LIMITED", retryable: true },
  500: { code: "AI_SERVER_ERROR", retryable: true },
  503: { code: "AI_UNAVAILABLE", retryable: true },
};

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly model: string;
  private readonly client: Anthropic | null;

  constructor() {
    this.model = getAiModel();
    let key: string;
    try {
      key = getAnthropicApiKey();
    } catch {
      this.client = null;
      return;
    }
    this.client = new Anthropic({
      apiKey: key,
      maxRetries: 1,
      timeout: getAiTimeoutMs(),
    });
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete(req: AiRequest): Promise<AiResult> {
    if (!this.client) {
      throw new AiProviderError("AI_NOT_CONFIGURED", "Anthropic API key not set");
    }

    const start = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.3,
        system: req.systemPrompt,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");

      const usage: AiUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };

      logger.info("ai_complete_success", {
        provider: this.id,
        model: this.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - start,
      });

      return {
        text,
        model: response.model,
        provider: this.id,
        usage,
        stopReason: response.stop_reason ?? "end_turn",
      };
    } catch (err) {
      this.handleError(err, start);
    }
  }

  async *stream(req: AiRequest): AsyncIterable<AiStreamEvent> {
    if (!this.client) {
      yield { type: "error", code: "AI_NOT_CONFIGURED", message: "Anthropic API key not set" };
      return;
    }

    const start = Date.now();
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.3,
        system: req.systemPrompt,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "text", text: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      const usage: AiUsage = {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      };

      logger.info("ai_stream_success", {
        provider: this.id,
        model: this.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - start,
      });

      yield {
        type: "done",
        model: final.model,
        provider: this.id,
        usage,
        stopReason: final.stop_reason ?? "end_turn",
      };
    } catch (err) {
      const { code } = this.classifyError(err);
      logger.error("ai_stream_error", { code, durationMs: Date.now() - start });
      yield { type: "error", code, message: "AI stream failed" };
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private classifyError(err: unknown): { code: string; retryable: boolean } {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return { code: "AI_TIMEOUT", retryable: true };
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return { code: "AI_UNAVAILABLE", retryable: true };
    }
    if (err instanceof Anthropic.APIError) {
      return HTTP_ERROR_CODES[err.status] ?? { code: "AI_PROVIDER_ERROR", retryable: false };
    }
    return { code: "AI_PROVIDER_ERROR", retryable: false };
  }

  private handleError(err: unknown, start: number): never {
    const { code, retryable } = this.classifyError(err);
    logger.error("ai_complete_error", { code, durationMs: Date.now() - start });
    throw new AiProviderError(code, "AI request failed", retryable);
  }
}
