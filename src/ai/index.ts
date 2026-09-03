// Provider factory — lazy singleton for production, replaceable in tests.
//
// Usage in production: createProvider() returns the AnthropicProvider instance.
// Usage in tests: call setProvider(mockProvider) to inject a test double.

import { AnthropicProvider } from "./anthropic";
import type { AIProvider } from "./provider";

export type { AIProvider, AiRequest, AiResult, AiStreamEvent, AiUsage, AiMessage } from "./provider";
export { AiProviderError } from "./provider";

let _provider: AIProvider | null = null;

export function createProvider(): AIProvider {
  if (!_provider) {
    _provider = new AnthropicProvider();
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
