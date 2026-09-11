// Server-side environment validation.
// Called at module load time in each server route — throws immediately
// if required vars are missing so misconfiguration fails at startup, not
// mid-request while serving a doctor.
//
// IMPORTANT: never expose these values to the browser. No NEXT_PUBLIC_ prefix.

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    throw new Error(
      `[ppms-copilot] Missing required server environment variable: ${name}. ` +
        `Check your .env.local or Vercel environment settings.`,
    );
  }
  return val.trim();
}

// Which AI provider is active — "groq" (default), "anthropic" (legacy).
export function getAiProvider(): "groq" | "anthropic" {
  const val = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (val === "anthropic") return "anthropic";
  return "groq"; // default
}

// Lazy-validate once per cold start per env var — used by the route module.
export function assertServerEnv(): void {
  if (getAiProvider() === "anthropic") {
    requireEnv("ANTHROPIC_API_KEY");
  } else {
    requireEnv("GROQ_API_KEY");
  }
  requireEnv("PPMS_CORE_URL");
}

// Accessors used by individual modules — each throws on first use if unset.
export function getGroqApiKey(): string {
  return requireEnv("GROQ_API_KEY");
}

export function getAnthropicApiKey(): string {
  return requireEnv("ANTHROPIC_API_KEY");
}

export function getPpmsCoreUrl(): string {
  const url = requireEnv("PPMS_CORE_URL");
  // Strip trailing slash to avoid double-slash in path joins
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function getAiModel(): string {
  if (process.env.AI_MODEL?.trim()) return process.env.AI_MODEL.trim();
  return getAiProvider() === "anthropic" ? "claude-opus-5" : "llama-3.1-8b-instant";
}

export function getAiTimeoutMs(): number {
  const raw = process.env.AI_REQUEST_TIMEOUT_MS;
  if (!raw) return 60_000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

// Per-tier model selection — used by the service layer to route capabilities.
// COPILOT_FAST_MODEL: quick summaries (snapshot, prev visits, timeline).
// COPILOT_REASONING_MODEL: deep longitudinal analysis (attention, draft note, follow-up).
// Both fall back to AI_MODEL (then to the provider default) when not set.
export function getCopilotFastModel(): string {
  return process.env.COPILOT_FAST_MODEL?.trim() || getAiModel();
}

// Reasoning model defaults to llama-3.3-70b-versatile — higher Groq rate limits
// than openai/gpt-oss-120b while still providing strong analytical capability.
// Override with COPILOT_REASONING_MODEL env var.
export function getCopilotReasoningModel(): string {
  if (process.env.COPILOT_REASONING_MODEL?.trim()) return process.env.COPILOT_REASONING_MODEL.trim();
  // If AI_MODEL is explicitly set, use it for both tiers
  if (process.env.AI_MODEL?.trim()) return process.env.AI_MODEL.trim();
  return getAiProvider() === "anthropic" ? "claude-opus-5" : "llama-3.3-70b-versatile";
}
