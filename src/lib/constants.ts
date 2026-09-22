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

// REFRACTIVE_GUIDANCE is on-demand only, same pattern as EXAM_GUIDANCE — PPMS
// Core sends this INTO the iframe (e.g. from a button on the Refraction /
// Anterior Segment / Posterior Segment sub-tabs) to request generation.
export const MSG_PPMS_REQUEST_REFRACTIVE_GUIDANCE = "PPMS_REQUEST_REFRACTIVE_GUIDANCE" as const;

// Sent once per PPMS_REQUEST_REFRACTIVE_GUIDANCE, whether the resulting
// on-demand generation succeeded or failed — carries either the structured
// per-eye + routing result or an error, so PPMS Core can render/update its
// shared refractive-guidance card across the three sub-tabs above.
export const MSG_PLUGIN_REFRACTIVE_GUIDANCE_RESULT = "PLUGIN_REFRACTIVE_GUIDANCE_RESULT" as const;

// Sent once per successful consolidated generation (and again after
// Regenerate) once planGuidance validates successfully — same eager pattern
// as MSG_PLUGIN_DIFFERENTIAL_UPDATE, since PLAN_GUIDANCE is part of the
// consolidated call, not on-demand. Carries the structured result so PPMS
// Core can render a persistent Plan Guidance card outside the plugin iframe.
// Message type name and payload shape (`result`, not `sections`/`items`)
// match PPMS Core's already-implemented receiver contract exactly.
export const MSG_PLUGIN_PLAN_GUIDANCE_UPDATE = "PLUGIN_PLAN_GUIDANCE_UPDATE" as const;

// Sent once per successful consolidated generation (and again after
// Regenerate) once assessmentContext validates successfully — same eager,
// pure-reuse posture as PLAN_GUIDANCE's followUpSummary field: no new AI
// call, this is the exact ASSESSMENT_CONTEXT text the doctor already sees in
// the Copilot's own Assessment tab, referenced a second time so PPMS Core
// can render it in a persistent card on its own Assessment tab, outside
// this iframe.
export const MSG_PLUGIN_ASSESSMENT_UPDATE = "PLUGIN_ASSESSMENT_UPDATE" as const;

// Sent once per successful consolidated generation (and again after
// Regenerate), carrying whichever of PATIENT_SNAPSHOT / PREVIOUS_VISIT_SUMMARY
// / TIMELINE_SUMMARY validated successfully this generation — each field is
// individually optional, so one failed section never blocks the other two.
// Same pure-reuse posture: no new AI call, these are the exact section texts
// already shown in the Copilot's own tabs. PPMS Core renders the three as
// sub-tabs within one Patient Profile card outside this iframe.
export const MSG_PLUGIN_PATIENT_PROFILE_UPDATE = "PLUGIN_PATIENT_PROFILE_UPDATE" as const;

// Sent once per successful consolidated generation (and again after
// Regenerate) once investigationGuidance validates successfully — same eager
// pattern as MSG_PLUGIN_PLAN_GUIDANCE_UPDATE. Carries the structured result
// so PPMS Core can render a persistent Investigation Guidance card outside
// the plugin iframe.
export const MSG_PLUGIN_INVESTIGATION_GUIDANCE_UPDATE = "PLUGIN_INVESTIGATION_GUIDANCE_UPDATE" as const;

// API route paths (server-side only)
export const COPILOT_STREAM_PATH = "/api/copilot/stream" as const;
// Consolidated endpoint: one request → all six sections as structured JSON
export const COPILOT_GENERATE_PATH = "/api/copilot/generate" as const;
