import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { AnthropicProvider } from "@/ai/anthropic";
import { AiProviderError } from "@/ai/provider";

// IMPORTANT: This test file never calls the real Anthropic API.
// All SDK calls are mocked at the module level.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AnthropicProvider", () => {
  describe("Configuration", () => {
    it("isConfigured() returns false when ANTHROPIC_API_KEY is not set", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      const provider = new AnthropicProvider();
      expect(provider.isConfigured()).toBe(false);
    });

    it("isConfigured() returns true when ANTHROPIC_API_KEY is set", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
      const provider = new AnthropicProvider();
      expect(provider.isConfigured()).toBe(true);
    });

    it("uses AI_MODEL from environment", () => {
      vi.stubEnv("AI_MODEL", "claude-sonnet-5");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      const provider = new AnthropicProvider();
      expect(provider.model).toBe("claude-sonnet-5");
    });

    it("defaults model to claude-opus-5 when AI_MODEL is not set", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      delete process.env.AI_MODEL;
      const provider = new AnthropicProvider();
      expect(provider.model).toBe("claude-opus-5");
    });

    it("id is always 'anthropic'", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      const provider = new AnthropicProvider();
      expect(provider.id).toBe("anthropic");
    });
  });

  describe("complete() — not configured", () => {
    it("throws AiProviderError with AI_NOT_CONFIGURED when key is absent", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      const provider = new AnthropicProvider();

      await expect(
        provider.complete({
          systemPrompt: "Test",
          messages: [{ role: "user", content: "Hello" }],
          maxTokens: 100,
        }),
      ).rejects.toMatchObject({
        code: "AI_NOT_CONFIGURED",
        name: "AiProviderError",
      });
    });
  });

  describe("stream() — not configured", () => {
    it("yields a single error event when key is absent", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      const provider = new AnthropicProvider();

      const events = [];
      for await (const event of provider.stream({
        systemPrompt: "Test",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 100,
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      if (events[0].type === "error") {
        expect(events[0].code).toBe("AI_NOT_CONFIGURED");
      }
    });
  });

  describe("Request construction", () => {
    it("complete() passes correct model, maxTokens, and temperature to SDK", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      vi.stubEnv("AI_MODEL", "claude-opus-5");

      // Mock the Anthropic SDK at module level
      const createMock = vi.fn().mockResolvedValue({
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Mock response text" }],
        usage: { input_tokens: 200, output_tokens: 50 },
      });

      vi.doMock("@anthropic-ai/sdk", () => ({
        default: class MockAnthropic {
          messages = { create: createMock };
        },
      }));

      vi.resetModules();
      const { AnthropicProvider: FreshProvider } = await import("@/ai/anthropic");
      const provider = new FreshProvider();

      await provider.complete({
        systemPrompt: "System prompt here",
        messages: [{ role: "user", content: "User message here" }],
        maxTokens: 500,
        temperature: 0.5,
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-opus-5",
          max_tokens: 500,
          temperature: 0.5,
          system: "System prompt here",
          messages: [{ role: "user", content: "User message here" }],
        }),
      );

      vi.doUnmock("@anthropic-ai/sdk");
    });

    it("uses 0.3 as default temperature when not specified", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

      const createMock = vi.fn().mockResolvedValue({
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "response" }],
        usage: { input_tokens: 100, output_tokens: 20 },
      });

      vi.doMock("@anthropic-ai/sdk", () => ({
        default: class MockAnthropic {
          messages = { create: createMock };
        },
      }));

      vi.resetModules();
      const { AnthropicProvider: FreshProvider } = await import("@/ai/anthropic");
      const provider = new FreshProvider();

      await provider.complete({
        systemPrompt: "s",
        messages: [{ role: "user", content: "u" }],
        maxTokens: 100,
        // temperature not specified
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.3 }),
      );

      vi.doUnmock("@anthropic-ai/sdk");
    });
  });

  describe("ANTHROPIC_API_KEY is never exposed", () => {
    it("complete() result does not contain the API key", async () => {
      const testKey = "sk-ant-super-secret-key-999";
      vi.stubEnv("ANTHROPIC_API_KEY", testKey);

      const createMock = vi.fn().mockResolvedValue({
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Some AI response text" }],
        usage: { input_tokens: 100, output_tokens: 30 },
      });
      vi.doMock("@anthropic-ai/sdk", () => ({
        default: class MockAnthropic {
          messages = { create: createMock };
        },
      }));

      vi.resetModules();
      const { AnthropicProvider: FreshProvider } = await import("@/ai/anthropic");
      const provider = new FreshProvider();

      const result = await provider.complete({
        systemPrompt: "Test",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 100,
      });

      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain(testKey);
      expect(resultStr).not.toContain("sk-ant");

      vi.doUnmock("@anthropic-ai/sdk");
    });
  });
});
