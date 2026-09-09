// Provider factory — lazy singleton for production, replaceable in tests.
//
// Usage in production: createProvider() reads AI_PROVIDER env var to select
//   "groq"      → GroqProvider
//   "anthropic" → AnthropicProvider  (legacy fallback)
//   anything else / unset → GroqProvider (default)
// Usage in tests: call setProvider(mockProvider) to inject a test double.

import { GroqProvider } from "./groq";
import { AnthropicProvider } from "./anthropic";
import type { AIProvider } from "./provider";

export type { AIProvider, AiRequest, AiResult, AiStreamEvent, AiUsage, AiMessage } from "./provider";
export { AiProviderError } from "./provider";

let _provider: AIProvider | null = null;

export function createProvider(): AIProvider {
  if (!_provider) {
    const name = process.env.AI_PROVIDER?.trim().toLowerCase();
    if (name === "anthropic") {
      _provider = new AnthropicProvider();
    } else {
      // "groq" or unset → Groq is the default provider
      _provider = new GroqProvider();
    }
  }
  return _provider;
}

// For testing — allows injecting a mock provider without touching env vars
export function setProvider(provider: AIProvider | null): void {
  _provider = provider;
}

// Reset to default (GroqProvider) — useful in test teardown
export function resetProvider(): void {
  _provider = null;
}
