// Provider factory — lazy singleton for production, replaceable in tests.
//
// Usage in production: createProvider() reads AI_PROVIDER env var to select
//   "gemini" → GeminiProvider, anything else → AnthropicProvider (default).
// Usage in tests: call setProvider(mockProvider) to inject a test double.

import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import type { AIProvider } from "./provider";

export type { AIProvider, AiRequest, AiResult, AiStreamEvent, AiUsage, AiMessage } from "./provider";
export { AiProviderError } from "./provider";

let _provider: AIProvider | null = null;

export function createProvider(): AIProvider {
  if (!_provider) {
    const name = process.env.AI_PROVIDER?.trim().toLowerCase();
    _provider = name === "gemini" ? new GeminiProvider() : new AnthropicProvider();
  }
  return _provider;
}

// For testing — allows injecting a mock provider without touching env vars
export function setProvider(provider: AIProvider | null): void {
  _provider = provider;
}

// Reset to default (AnthropicProvider) — useful in test teardown
export function resetProvider(): void {
  _provider = null;
}
