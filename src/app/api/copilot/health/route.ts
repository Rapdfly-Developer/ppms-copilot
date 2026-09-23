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

  // Two tests in parallel:
  //   A) basic call (no reasoningEffort) — proves API key + model are valid
  //   B) production-like call (reasoningEffort: "high", larger maxTokens) — proves
  //      the actual copilot generation parameters work. This is what was failing.
  try {
    const [basicResult, prodResult] = await Promise.allSettled([
      provider.complete({
        systemPrompt: "You are a test assistant. Respond with exactly one word.",
        messages: [{ role: "user", content: "Say: OK" }],
        maxTokens: 10,
        modelOverride: reasoningModel,
      }),
      provider.complete({
        systemPrompt: "Return ONLY a valid JSON object with one key: {\"ok\": true}",
        messages: [{ role: "user", content: "Return the JSON object now." }],
        maxTokens: 500,
        reasoningEffort: "high",
        modelOverride: reasoningModel,
      }),
    ]);

    const basicOk = basicResult.status === "fulfilled";
    const prodOk = prodResult.status === "fulfilled";

    return json({
      ok: basicOk && prodOk,
      provider: aiProvider,
      reasoningModel,
      fastModel,
      basic: {
        ok: basicOk,
        response: basicOk ? basicResult.value.text.trim() : undefined,
        error: !basicOk ? String((basicResult as PromiseRejectedResult).reason) : undefined,
        inputTokens: basicOk ? basicResult.value.usage.inputTokens : undefined,
        outputTokens: basicOk ? basicResult.value.usage.outputTokens : undefined,
      },
      production: {
        ok: prodOk,
        response: prodOk ? prodResult.value.text.trim().slice(0, 200) : undefined,
        error: !prodOk ? String((prodResult as PromiseRejectedResult).reason) : undefined,
        inputTokens: prodOk ? prodResult.value.usage.inputTokens : undefined,
        outputTokens: prodOk ? prodResult.value.usage.outputTokens : undefined,
      },
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
