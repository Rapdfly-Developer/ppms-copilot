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
  MSG_PLUGIN_READY,
  MSG_PLUGIN_DRAFT_CONFIRMED,
  MSG_PLUGIN_ERROR,
  MSG_PLUGIN_CLOSE,
  MSG_PLUGIN_DIFFERENTIAL_UPDATE,
  MSG_PLUGIN_EXAM_GUIDANCE_RESULT,
} from "@/lib/constants";
import type { DifferentialDiagnosisItem, ExamGuidanceSection } from "@/types/client";

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
// an on-demand EXAM_GUIDANCE generation. No token — the plugin already holds
// one in memory from PPMS_INIT for the current session; this message only
// needs to identify which visit the request is for, so the handler can
// confirm it matches the session already established.
export type PpmsRequestExamGuidanceMessage = {
  type: typeof MSG_PPMS_REQUEST_EXAM_GUIDANCE;
  pluginId: string;
  visitId: string;
};

export type InboundPluginMessage = PpmsInitMessage | PpmsRequestExamGuidanceMessage;

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

export type OutboundPluginMessage =
  | PluginReadyMessage
  | PluginDraftConfirmedMessage
  | PluginErrorMessage
  | PluginCloseMessage
  | PluginDifferentialUpdateMessage
  | PluginExamGuidanceResultMessage;
