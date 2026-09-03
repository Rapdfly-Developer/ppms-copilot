// Stable identifiers shared across the Copilot project.
// Must match the values registered in PPMS Core's plugin manifest.

export const PLUGIN_ID = "ppms.plugin.ai-clinical-copilot" as const;
export const PPMS_VERSION = "16.2.9" as const;

// postMessage message type strings — must match ExternalPluginSlotClient.tsx in PPMS Core
export const MSG_PPMS_INIT = "PPMS_INIT" as const;
export const MSG_PLUGIN_READY = "PLUGIN_READY" as const;
export const MSG_PLUGIN_DRAFT_CONFIRMED = "PLUGIN_DRAFT_CONFIRMED" as const;
export const MSG_PLUGIN_ERROR = "PLUGIN_ERROR" as const;
export const MSG_PLUGIN_CLOSE = "PLUGIN_CLOSE" as const;

// Token constraints (must mirror PPMS Core's plugin-token.ts)
export const MAX_TOKEN_LIFETIME_SECONDS = 600;
export const MAX_TOKEN_LIFETIME_MS = MAX_TOKEN_LIFETIME_SECONDS * 1000;

// Sent by Copilot when the token expires mid-session, requesting re-issuance.
// PPMS Core should respond with a fresh PPMS_INIT message.
export const MSG_PLUGIN_TOKEN_EXPIRED = "PLUGIN_TOKEN_EXPIRED" as const;

// API route paths (server-side only)
export const COPILOT_STREAM_PATH = "/api/copilot/stream" as const;
