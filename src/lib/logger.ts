// Structured logging abstraction.
//
// AUDIT POLICY — fields that MUST NOT appear in any log line:
//   patientRef, patientName, patientId, udid, doctorId, hospitalId,
//   contextText, promptText, aiResponseText, draftText.
//
// Safe fields (opaque IDs and metrics only):
//   visitId (opaque integer string), capability, endpoint, status,
//   durationMs, code, model, provider, inputTokens, outputTokens.
//
// PPMS Core's PluginAudit table is the authoritative data-access audit trail.
// This logger is for operational observability only (latency, errors, rates).

type LogLevel = "debug" | "info" | "warn" | "error";

// Explicitly typed to prevent accidental PII fields
export type SafeLogContext = {
  capability?: string;
  visitId?: string;
  endpoint?: string;
  status?: number;
  durationMs?: number;
  code?: string;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  maxTokens?: number;
  visitsIncluded?: number;
  appointmentsIncluded?: number;
  timelineEventsIncluded?: number;
  estimatedTokens?: number;
  warningCount?: number;
  reason?: string;
  // Per-request observability fields (added for Copilot upgrade)
  reasoningEffort?: string;   // "medium" | "high"
  modelTier?: string;         // "fast" | "reasoning"
  cacheHit?: boolean;         // true when response served from in-memory cache
  safetyResult?: string;      // "ok" | "unsafe" | "warning" | "truncated" | "empty"
  latencyMs?: number;         // total pipeline latency including context fetch + AI call
};

function emit(level: LogLevel, event: string, ctx?: SafeLogContext): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  });
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (event: string, ctx?: SafeLogContext) => emit("debug", event, ctx),
  info: (event: string, ctx?: SafeLogContext) => emit("info", event, ctx),
  warn: (event: string, ctx?: SafeLogContext) => emit("warn", event, ctx),
  error: (event: string, ctx?: SafeLogContext) => emit("error", event, ctx),
};
