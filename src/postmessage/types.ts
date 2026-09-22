// postMessage protocol types.
//
// This file is used by BOTH the browser (usePluginBridge hook, Phase 5) and
// in server-side schema validation. Keep it import-free so it works in both
// environments.
//
// Protocol defined by PPMS Core's ExternalPluginSlotClient.tsx.
// Do not change message type strings — they must match exactly.

import {
  PLUGIN_ID,
  MSG_PPMS_INIT,
  MSG_PPMS_REQUEST_EXAM_GUIDANCE,
  MSG_PPMS_REQUEST_REFRACTIVE_GUIDANCE,
  MSG_PLUGIN_READY,
  MSG_PLUGIN_DRAFT_CONFIRMED,
  MSG_PLUGIN_ERROR,
  MSG_PLUGIN_CLOSE,
  MSG_PLUGIN_DIFFERENTIAL_UPDATE,
  MSG_PLUGIN_EXAM_GUIDANCE_RESULT,
  MSG_PLUGIN_REFRACTIVE_GUIDANCE_RESULT,
  MSG_PLUGIN_PLAN_GUIDANCE_UPDATE,
} from "@/lib/constants";
import type {
  DifferentialDiagnosisItem,
  ExamGuidanceSection,
  RefractiveGuidanceResult,
  PlanGuidanceResult,
} from "@/types/client";

// ── Inbound: messages PPMS Core sends TO the Copilot ─────────────────────────

export type PpmsInitMessage = {
  type: typeof MSG_PPMS_INIT;
  version: "1";
  pluginId: string;
  token: string;       // short-lived HMAC-signed plugin token
  patientRef: string;
  visitId: string;
  ppmsVersion: string;
};

// Sent by PPMS Core (e.g. a button on the General/Ophthalmic tabs) to request
// an on-demand EXAM_GUIDANCE generation.
//
// `token` is OPTIONAL and, when present, is a FRESH plugin token PPMS Core
// mints (via POST /api/v1/plugin-token) immediately before sending this
// trigger — not the original PPMS_INIT session token, which has a hard
// 10-minute server-side expiry (MAX_TOKEN_LIFETIME_SECONDS) and may well have
// already lapsed by the time an on-demand capability is triggered deep into
// a visit. Absent for backward compatibility with a PPMS Core build that
// doesn't send one yet — the handler falls back to the session token in that
// case (see lib/on-demand-token.ts).
export type PpmsRequestExamGuidanceMessage = {
  type: typeof MSG_PPMS_REQUEST_EXAM_GUIDANCE;
  pluginId: string;
  visitId: string;
  token?: string;
};

// Sent by PPMS Core (a button shared across the Refraction / Anterior
// Segment / Posterior Segment sub-tabs) to request an on-demand
// REFRACTIVE_GUIDANCE generation. Same optional fresh-token posture as
// PpmsRequestExamGuidanceMessage, built in from the start this time.
export type PpmsRequestRefractiveGuidanceMessage = {
  type: typeof MSG_PPMS_REQUEST_REFRACTIVE_GUIDANCE;
  pluginId: string;
  visitId: string;
  token?: string;
};

export type InboundPluginMessage =
  | PpmsInitMessage
  | PpmsRequestExamGuidanceMessage
  | PpmsRequestRefractiveGuidanceMessage;

// ── Outbound: messages the Copilot sends TO PPMS Core ────────────────────────

export type PluginReadyMessage = {
  type: typeof MSG_PLUGIN_READY;
  pluginId: typeof PLUGIN_ID;
};

// Sent when the doctor reviews and confirms a draft.
// IMPORTANT: the plugin token is NOT included here.
// PPMS Core must use the doctor's session cookie to authorize the save.
export type PluginDraftConfirmedMessage = {
  type: typeof MSG_PLUGIN_DRAFT_CONFIRMED;
  pluginId: typeof PLUGIN_ID;
  draftType: "consultation_note" | "follow_up_summary";
  draftText: string;
  visitId: string;
};

export type PluginErrorMessage = {
  type: typeof MSG_PLUGIN_ERROR;
  pluginId: typeof PLUGIN_ID;
  code: string;
  message: string;
};

export type PluginCloseMessage = {
  type: typeof MSG_PLUGIN_CLOSE;
  pluginId: typeof PLUGIN_ID;
};

// Sent once per successful consolidated generation (and again after
// Regenerate) once differentialDiagnosis validates successfully — never on a
// validation failure. IMPORTANT: no patientRef, no token — visitId only,
// same security posture as PluginDraftConfirmedMessage. `items` carries only
// what the doctor already sees rendered in the Copilot's own Differential Dx
// tab: no PHI beyond what's already been sent via other plugin messages.
export type PluginDifferentialUpdateMessage = {
  type: typeof MSG_PLUGIN_DIFFERENTIAL_UPDATE;
  pluginId: typeof PLUGIN_ID;
  visitId: string;
  items: DifferentialDiagnosisItem[]; // [] means "considered — nothing to show" (e.g. insufficient evidence)
};

// Sent once per PPMS_REQUEST_EXAM_GUIDANCE, whether the on-demand generation
// it triggered succeeded or failed. Same no-token, no-PHI-beyond-what's-
// already-sent posture as PluginDifferentialUpdateMessage: `sections` carries
// only the two segment blocks the doctor already sees rendered in the
// Copilot's own output.
export type PluginExamGuidanceResultMessage =
  | {
      type: typeof MSG_PLUGIN_EXAM_GUIDANCE_RESULT;
      pluginId: typeof PLUGIN_ID;
      visitId: string;
      ok: true;
      sections: ExamGuidanceSection[]; // [] means "considered — nothing to correlate" (e.g. insufficient data)
    }
  | {
      type: typeof MSG_PLUGIN_EXAM_GUIDANCE_RESULT;
      pluginId: typeof PLUGIN_ID;
      visitId: string;
      ok: false;
      errorCode: string;
      errorMessage: string;
    };

// Sent once per PPMS_REQUEST_REFRACTIVE_GUIDANCE, whether the on-demand
// generation it triggered succeeded or failed. Same no-token,
// no-PHI-beyond-what's-already-sent posture as PluginExamGuidanceResultMessage:
// `result` carries only the per-eye interpretation and routing guidance the
// doctor already sees rendered in the Copilot's own output.
export type PluginRefractiveGuidanceResultMessage =
  | {
      type: typeof MSG_PLUGIN_REFRACTIVE_GUIDANCE_RESULT;
      pluginId: typeof PLUGIN_ID;
      visitId: string;
      ok: true;
      result: RefractiveGuidanceResult;
    }
  | {
      type: typeof MSG_PLUGIN_REFRACTIVE_GUIDANCE_RESULT;
      pluginId: typeof PLUGIN_ID;
      visitId: string;
      ok: false;
      errorCode: string;
      errorMessage: string;
    };

// Sent once per successful consolidated generation (and again after
// Regenerate) once planGuidance validates successfully — never on a
// validation failure. Same no-token, no-PHI-beyond-what's-already-sent
// posture as PluginDifferentialUpdateMessage. Message type name and payload
// shape match PPMS Core's already-implemented receiver contract exactly:
// `result` (not `sections`/`items`), holding the same PlanGuidanceResult
// shape validatePlanGuidance() produces server-side.
export type PluginPlanGuidanceUpdateMessage = {
  type: typeof MSG_PLUGIN_PLAN_GUIDANCE_UPDATE;
  pluginId: typeof PLUGIN_ID;
  visitId: string;
  result: PlanGuidanceResult;
};

export type OutboundPluginMessage =
  | PluginReadyMessage
  | PluginDraftConfirmedMessage
  | PluginErrorMessage
  | PluginCloseMessage
  | PluginDifferentialUpdateMessage
  | PluginExamGuidanceResultMessage
  | PluginRefractiveGuidanceResultMessage
  | PluginPlanGuidanceUpdateMessage;
