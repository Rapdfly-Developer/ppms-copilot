// Structured error types used throughout the pipeline.
//
// IMPORTANT: the user-facing message strings defined here are the ONLY text
// the client ever receives for errors. Vendor error messages (Anthropic SDK,
// PPMS Core HTTP body) must never be forwarded — they may contain echoed
// request content and therefore potentially patient data.

export const ERROR_CODES = {
  TOKEN_MISSING: "TOKEN_MISSING",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_INVALID: "TOKEN_INVALID",
  PLUGIN_DISABLED: "PLUGIN_DISABLED",
  PATIENT_NOT_FOUND: "PATIENT_NOT_FOUND",
  PPMS_UNAVAILABLE: "PPMS_UNAVAILABLE",
  PPMS_API_ERROR: "PPMS_API_ERROR",
  AI_UNAVAILABLE: "AI_UNAVAILABLE",
  AI_RATE_LIMITED: "AI_RATE_LIMITED",
  AI_TIMEOUT: "AI_TIMEOUT",
  AI_NOT_CONFIGURED: "AI_NOT_CONFIGURED",
  AI_AUTH_FAILED: "AI_AUTH_FAILED",
  RESPONSE_VALIDATION_FAILED: "RESPONSE_VALIDATION_FAILED",
  RESPONSE_EMPTY: "RESPONSE_EMPTY",
  RESPONSE_TRUNCATED: "RESPONSE_TRUNCATED",
  RESPONSE_UNSAFE: "RESPONSE_UNSAFE",
  NOTE_INCOMPLETE: "NOTE_INCOMPLETE",
  INVALID_CAPABILITY: "INVALID_CAPABILITY",
  MISSING_PERMISSION: "MISSING_PERMISSION",
  INVALID_REQUEST: "INVALID_REQUEST",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class CopilotError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = "CopilotError";
  }
}

// Fixed user-facing messages. Never include technical details or vendor text.
export const USER_MESSAGES: Record<ErrorCode, string> = {
  TOKEN_MISSING: "Authentication required. Please reload the patient page.",
  TOKEN_EXPIRED: "Session expired. Please reload the patient page.",
  TOKEN_INVALID: "Authentication failed. Please reload the patient page.",
  PLUGIN_DISABLED: "AI Copilot is not enabled for your account.",
  PATIENT_NOT_FOUND: "Patient not found in your records.",
  PPMS_UNAVAILABLE: "PPMS is temporarily unavailable. Please try again.",
  PPMS_API_ERROR: "Failed to retrieve patient data. Please try again.",
  AI_UNAVAILABLE: "AI service is temporarily unavailable. Please try again later.",
  AI_RATE_LIMITED: "AI service is busy. Please wait a moment and try again.",
  AI_TIMEOUT: "AI request timed out. Please try again.",
  AI_NOT_CONFIGURED: "AI provider is not configured. Please contact your administrator.",
  AI_AUTH_FAILED: "AI provider authentication failed. Please contact your administrator.",
  RESPONSE_VALIDATION_FAILED:
    "AI response did not meet clinical safety requirements. Please try again.",
  RESPONSE_EMPTY: "AI returned an empty response. Please try again.",
  RESPONSE_TRUNCATED: "AI response was cut short. Please try again.",
  RESPONSE_UNSAFE: "AI response contained language that requires doctor review before display.",
  NOTE_INCOMPLETE: "AI note draft is missing required sections. Please try again.",
  INVALID_CAPABILITY: "Invalid capability requested.",
  MISSING_PERMISSION: "You do not have permission to use this feature.",
  INVALID_REQUEST: "Invalid request. Please try again.",
  INTERNAL_ERROR: "An unexpected error occurred. Please try again.",
};
