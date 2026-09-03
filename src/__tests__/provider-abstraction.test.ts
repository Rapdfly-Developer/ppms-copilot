import { describe, it, expect, vi, afterEach } from "vitest";
import type { AIProvider, AiRequest, AiResult, AiStreamEvent } from "@/ai/provider";
import { AiProviderError } from "@/ai/provider";
import { createProvider, setProvider, resetProvider } from "@/ai";

afterEach(() => {
  resetProvider();
  vi.restoreAllMocks();
});

// A minimal mock provider for interface testing
class MockProvider implements AIProvider {
  readonly id = "mock";
  readonly model = "mock-model-1";
  private configured: boolean;

  constructor(configured = true) {
    this.configured = configured;
  }

  isConfigured() {
    return this.configured;
  }

  async complete(req: AiRequest): Promise<AiResult> {
    return {
      text: `Mock response to: ${req.messages[0].content.slice(0, 20)}`,
      model: this.model,
      provider: this.id,
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
    };
  }

  async *stream(req: AiRequest): AsyncIterable<AiStreamEvent> {
    yield { type: "text", text: "Mock " };
    yield { type: "text", text: "response." };
    yield {
      type: "done",
      model: this.model,
      provider: this.id,
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
    };
  }
}

const SAMPLE_REQUEST: AiRequest = {
  systemPrompt: "You are a test assistant.",
  messages: [{ role: "user", content: "Test message" }],
  maxTokens: 100,
};

describe("AIProvider abstraction", () => {
  describe("Interface contract", () => {
    it("createProvider returns an object implementing AIProvider interface", () => {
      setProvider(new MockProvider());
      const provider = createProvider();
      expect(typeof provider.id).toBe("string");
      expect(typeof provider.model).toBe("string");
      expect(typeof provider.isConfigured).toBe("function");
      expect(typeof provider.complete).toBe("function");
      expect(typeof provider.stream).toBe("function");
    });

    it("isConfigured() returns false for unconfigured provider", () => {
      setProvider(new MockProvider(false));
      const provider = createProvider();
      expect(provider.isConfigured()).toBe(false);
    });

    it("isConfigured() returns true for configured provider", () => {
      setProvider(new MockProvider(true));
      const provider = createProvider();
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe("complete()", () => {
    it("returns AiResult with text, model, provider, usage, stopReason", async () => {
      setProvider(new MockProvider());
      const provider = createProvider();
      const result = await provider.complete(SAMPLE_REQUEST);

      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);
      expect(typeof result.model).toBe("string");
      expect(typeof result.provider).toBe("string");
      expect(typeof result.usage.inputTokens).toBe("number");
      expect(typeof result.usage.outputTokens).toBe("number");
      expect(typeof result.stopReason).toBe("string");
    });
  });

  describe("stream()", () => {
    it("yields text events followed by done event", async () => {
      setProvider(new MockProvider());
      const provider = createProvider();

      const events: AiStreamEvent[] = [];
      for await (const event of provider.stream(SAMPLE_REQUEST)) {
        events.push(event);
      }

      const textEvents = events.filter((e) => e.type === "text");
      const doneEvents = events.filter((e) => e.type === "done");
      expect(textEvents.length).toBeGreaterThan(0);
      expect(doneEvents).toHaveLength(1);
      // done event must be last
      expect(events[events.length - 1].type).toBe("done");
    });

    it("accumulated text events equal the complete response", async () => {
      setProvider(new MockProvider());
      const provider = createProvider();

      let accumulated = "";
      for await (const event of provider.stream(SAMPLE_REQUEST)) {
        if (event.type === "text") accumulated += event.text;
      }

      expect(accumulated).toBe("Mock response.");
    });
  });

  describe("AiProviderError", () => {
    it("has a code, message, and retryable flag", () => {
      const err = new AiProviderError("AI_RATE_LIMITED", "Rate limited", true);
      expect(err.code).toBe("AI_RATE_LIMITED");
      expect(err.message).toBe("Rate limited");
      expect(err.retryable).toBe(true);
      expect(err.name).toBe("AiProviderError");
    });

    it("defaults retryable to false", () => {
      const err = new AiProviderError("AI_AUTH_FAILED", "Auth failed");
      expect(err.retryable).toBe(false);
    });
  });

  describe("setProvider and resetProvider", () => {
    it("setProvider replaces the singleton", () => {
      const mock1 = new MockProvider();
      const mock2 = new MockProvider();
      mock2.id; // keep ref

      setProvider(mock1);
      expect(createProvider()).toBe(mock1);

      setProvider(mock2);
      expect(createProvider()).toBe(mock2);
    });

    it("resetProvider causes next createProvider to build AnthropicProvider", () => {
      setProvider(new MockProvider());
      resetProvider();
      // After reset, createProvider creates AnthropicProvider
      // We can only verify it's not the mock
      const provider = createProvider();
      expect(provider.id).toBe("anthropic");
    });
  });
});
