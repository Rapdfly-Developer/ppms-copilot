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

// Sent once per successful consolidated generation (and again after
// Regenerate) once differentialDiagnosis validates successfully. Carries the
// structured consideration list so PPMS Core can render a persistent
// differential-diagnosis card outside the plugin iframe, cached per visit.
export const MSG_PLUGIN_DIFFERENTIAL_UPDATE = "PLUGIN_DIFFERENTIAL_UPDATE" as const;

// EXAM_GUIDANCE is on-demand only — PPMS Core sends this INTO the iframe
// (e.g. from a button on the General/Ophthalmic tabs) to request generation.
export const MSG_PPMS_REQUEST_EXAM_GUIDANCE = "PPMS_REQUEST_EXAM_GUIDANCE" as const;

// Sent once per PPMS_REQUEST_EXAM_GUIDANCE, whether the resulting on-demand
// generation succeeded or failed — carries either the two structured segment
// sections or an error, so PPMS Core can render/update its exam-guidance card
// on the General and Ophthalmic tabs, outside this iframe.
export const MSG_PLUGIN_EXAM_GUIDANCE_RESULT = "PLUGIN_EXAM_GUIDANCE_RESULT" as const;

// API route paths (server-side only)
export const COPILOT_STREAM_PATH = "/api/copilot/stream" as const;
// Consolidated endpoint: one request → all six sections as structured JSON
export const COPILOT_GENERATE_PATH = "/api/copilot/generate" as const;
