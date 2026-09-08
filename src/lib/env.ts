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

// Which AI provider is active — "gemini" or "anthropic" (default).
export function getAiProvider(): "gemini" | "anthropic" {
  return process.env.AI_PROVIDER?.trim().toLowerCase() === "gemini"
    ? "gemini"
    : "anthropic";
}

// Lazy-validate once per cold start per env var — used by the route module.
export function assertServerEnv(): void {
  if (getAiProvider() === "gemini") {
    requireEnv("GEMINI_API_KEY");
  } else {
    requireEnv("ANTHROPIC_API_KEY");
  }
  requireEnv("PPMS_CORE_URL");
}

// Accessors used by individual modules — each throws on first use if unset.
export function getAnthropicApiKey(): string {
  return requireEnv("ANTHROPIC_API_KEY");
}

export function getGeminiApiKey(): string {
  return requireEnv("GEMINI_API_KEY");
}

export function getPpmsCoreUrl(): string {
  const url = requireEnv("PPMS_CORE_URL");
  // Strip trailing slash to avoid double-slash in path joins
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function getAiModel(): string {
  if (process.env.AI_MODEL?.trim()) return process.env.AI_MODEL.trim();
  return getAiProvider() === "gemini" ? "gemini-3.6-flash" : "claude-opus-5";
}

export function getAiTimeoutMs(): number {
  const raw = process.env.AI_REQUEST_TIMEOUT_MS;
  if (!raw) return 60_000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}
