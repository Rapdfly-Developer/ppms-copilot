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
  MSG_PLUGIN_READY,
  MSG_PLUGIN_DRAFT_CONFIRMED,
  MSG_PLUGIN_ERROR,
  MSG_PLUGIN_CLOSE,
} from "@/lib/constants";

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

export type InboundPluginMessage = PpmsInitMessage;

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

export type OutboundPluginMessage =
  | PluginReadyMessage
  | PluginDraftConfirmedMessage
  | PluginErrorMessage
  | PluginCloseMessage;
