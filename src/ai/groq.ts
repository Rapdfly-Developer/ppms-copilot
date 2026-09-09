// GroqProvider — only file in this project that imports the openai SDK pointed
// at Groq's OpenAI-compatible endpoint.
//
// Security rules:
//   - API key read from process.env only, never from a client-supplied argument.
//   - All SDK errors caught and normalised to AiProviderError with stable codes.
//   - Vendor error text is never forwarded to the caller.

import OpenAI from "openai";
import { getGroqApiKey, getAiModel, getAiTimeoutMs } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { AIProvider, AiRequest, AiResult, AiStreamEvent, AiUsage } from "./provider";
import { AiProviderError } from "./provider";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const HTTP_ERROR_CODES: Record<number, { code: string; retryable: boolean }> = {
  400: { code: "AI_UNAVAILABLE",    retryable: false },
  401: { code: "AI_AUTH_FAILED",    retryable: false },
  403: { code: "AI_AUTH_FAILED",    retryable: false },
  404: { code: "AI_NOT_CONFIGURED", retryable: false },
  429: { code: "AI_RATE_LIMITED",   retryable: true  },
  500: { code: "AI_UNAVAILABLE",    retryable: true  },
  503: { code: "AI_UNAVAILABLE",    retryable: true  },
};

function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "stop":          return "end_turn";
    case "length":        return "max_tokens";
    case "content_filter":return "content_filtered";
    default:              return reason ?? "end_turn";
  }
}

export class GroqProvider implements AIProvider {
  readonly id = "groq";
  readonly model: string;
  private readonly client: OpenAI | null;
  private readonly timeoutMs: number;

  constructor() {
    this.model = getAiModel();
    this.timeoutMs = getAiTimeoutMs();
    let key: string;
    try {
      key = getGroqApiKey();
    } catch {
      this.client = null;
      return;
    }
    this.client = new OpenAI({
      apiKey: key,
      baseURL: GROQ_BASE_URL,
      timeout: this.timeoutMs,
      maxRetries: 0, // retries handled at the service layer
    });
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete(req: AiRequest): Promise<AiResult> {
    if (!this.client) {
      throw new AiProviderError("AI_NOT_CONFIGURED", "Groq API key not set");
    }

    const start = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.3,
        messages: [
          { role: "system", content: req.systemPrompt },
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        stream: false,
      });

      const choice = response.choices[0];
      const text = choice?.message?.content ?? "";
      const usage: AiUsage = {
        inputTokens:  response.usage?.prompt_tokens     ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      };
      const stopReason = mapFinishReason(choice?.finish_reason);

      logger.info("ai_complete_success", {
        provider: this.id,
        model: this.model,
        inputTokens:  usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - start,
      });

      return { text, model: this.model, provider: this.id, usage, stopReason };
    } catch (err) {
      this.handleError(err, start);
    }
  }

  async *stream(req: AiRequest): AsyncIterable<AiStreamEvent> {
    if (!this.client) {
      yield { type: "error", code: "AI_NOT_CONFIGURED", message: "Groq API key not set" };
      return;
    }

    const start = Date.now();
    let inputTokens  = 0;
    let outputTokens = 0;
    let stopReason   = "end_turn";

    try {
      const streamResponse = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.3,
        messages: [
          { role: "system", content: req.systemPrompt },
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        stream: true,
        stream_options: { include_usage: true },
      });

      for await (const chunk of streamResponse) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          yield { type: "text", text: delta };
        }

        // Usage arrives on the final chunk when include_usage is set
        if (chunk.usage) {
          inputTokens  = chunk.usage.prompt_tokens     ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) {
          stopReason = mapFinishReason(finishReason);
        }
      }

      logger.info("ai_stream_success", {
        provider: this.id,
        model: this.model,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - start,
      });

      yield {
        type: "done",
        model: this.model,
        provider: this.id,
        usage: { inputTokens, outputTokens },
        stopReason,
      };
    } catch (err) {
      const { code } = this.classifyError(err);
      logger.error("ai_stream_error", { code, durationMs: Date.now() - start });
      yield { type: "error", code, message: "AI stream failed" };
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private classifyError(err: unknown): { code: string; retryable: boolean } {
    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      return { code: "AI_TIMEOUT", retryable: true };
    }
    if (err instanceof OpenAI.APIError) {
      logger.error("groq_http_error", {
        status: err.status,
        model:  this.model,
        reason: err.message,
      });
      if (err.status !== undefined && HTTP_ERROR_CODES[err.status]) {
        return HTTP_ERROR_CODES[err.status];
      }
      const msg = err.message?.toLowerCase() ?? "";
      if (msg.includes("timeout") || msg.includes("timed out")) {
        return { code: "AI_TIMEOUT", retryable: true };
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
