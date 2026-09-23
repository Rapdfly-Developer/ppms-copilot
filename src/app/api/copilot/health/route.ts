// GET /api/copilot/health
//
// Diagnostic endpoint — tests Groq connectivity with a minimal call and
// returns the actual provider error message so misconfiguration is visible
// without needing to read Vercel logs.
//
// Safe to call unauthenticated: no patient data is sent to the AI.

export const runtime = "nodejs";

import { createProvider } from "@/ai";
import { AiProviderError } from "@/ai/provider";
import { getCopilotReasoningModel, getCopilotFastModel, getAiProvider } from "@/lib/env";

export async function GET(): Promise<Response> {
  const provider = createProvider();
  const reasoningModel = getCopilotReasoningModel();
  const fastModel = getCopilotFastModel();
  const aiProvider = getAiProvider();

  if (!provider.isConfigured()) {
    return json({
      ok: false,
      provider: aiProvider,
      reasoningModel,
      fastModel,
      error: "AI_NOT_CONFIGURED",
      detail: "API key is missing or empty. Check GROQ_API_KEY / ANTHROPIC_API_KEY in Vercel env.",
    }, 503);
  }

  // Minimal test call — ask for a one-word answer to keep cost/latency low.
  try {
    const result = await provider.complete({
      systemPrompt: "You are a test assistant. Respond with exactly one word.",
      messages: [{ role: "user", content: "Say: OK" }],
      maxTokens: 10,
      modelOverride: reasoningModel,
    });
    return json({
      ok: true,
      provider: aiProvider,
      reasoningModel,
      fastModel,
      response: result.text.trim(),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  } catch (err) {
    const code = err instanceof AiProviderError ? err.code : "UNKNOWN";
    const detail = err instanceof Error ? err.message : String(err);
    return json({
      ok: false,
      provider: aiProvider,
      reasoningModel,
      fastModel,
      error: code,
      detail,
    }, 503);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
