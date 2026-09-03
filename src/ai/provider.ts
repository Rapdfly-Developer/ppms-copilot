// AIProvider interface and shared types.
//
// The rest of the application depends ONLY on this interface — never on any
// concrete provider (Anthropic, OpenAI, etc.). This allows swapping or adding
// providers without touching service code.

export type AiMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AiRequest = {
  systemPrompt: string;
  messages: AiMessage[];
  maxTokens: number;
  temperature?: number; // defaults to 0.3 in each provider
};

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type AiResult = {
  text: string;
  model: string;
  provider: string;
  usage: AiUsage;
  stopReason: string;
};

export type AiStreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; model: string; provider: string; usage: AiUsage; stopReason: string }
  | { type: "error"; code: string; message: string };

// Stable error thrown by any provider implementation
export class AiProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export interface AIProvider {
  /** Stable identifier — recorded in audit logs (e.g. "anthropic") */
  readonly id: string;
  /** Active model name — used in audit and UI display */
  readonly model: string;
  /** Returns false (rather than throwing) when the API key is absent */
  isConfigured(): boolean;
  /** Non-streaming completion — used for non-UI requests */
  complete(req: AiRequest): Promise<AiResult>;
  /** Streaming completion — yields AiStreamEvent items */
  stream(req: AiRequest): AsyncIterable<AiStreamEvent>;
}
