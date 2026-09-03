/**
 * Draft Confirmation Contract
 *
 * Defines the interface between the AI Copilot and PPMS Core for the
 * consultation note and follow-up draft confirmation flow.
 *
 * ─────────────────────────────────────────────────────────────
 * FLOW (current and required)
 * ─────────────────────────────────────────────────────────────
 *
 *   Copilot generates draft
 *       ↓
 *   Doctor reviews in Copilot UI
 *       ↓
 *   Doctor clicks "Confirm" → Copilot sends PLUGIN_DRAFT_CONFIRMED (postMessage)
 *       ↓
 *   PPMS Core receives PLUGIN_DRAFT_CONFIRMED
 *       ↓ ← PPMS Core must implement this step
 *   PPMS Core validates (doctor session, visitId ownership)
 *       ↓
 *   PPMS Core saves draft to EMR (visit record)
 *
 * ─────────────────────────────────────────────────────────────
 * COPILOT RESPONSIBILITIES (implemented in postmessage/types.ts)
 * ─────────────────────────────────────────────────────────────
 *
 * The Copilot sends PLUGIN_DRAFT_CONFIRMED with this exact shape:
 *
 *   {
 *     type: "PLUGIN_DRAFT_CONFIRMED",
 *     pluginId: "ppms.plugin.ai-clinical-copilot",
 *     draftType: "consultation_note" | "follow_up_summary",
 *     draftText: "<doctor-reviewed draft text>",
 *     visitId: "<the active visitId from the plugin token>"
 *   }
 *
 * The plugin token is NOT included in the postMessage payload.
 * PPMS Core must use the doctor's session cookie to authorize the save.
 *
 * ─────────────────────────────────────────────────────────────
 * REQUIRED PPMS CORE CHANGES (NOT YET IMPLEMENTED)
 * ─────────────────────────────────────────────────────────────
 *
 * 1. ExternalPluginSlotClient.tsx — handle PLUGIN_DRAFT_CONFIRMED:
 *    Current:  logs the event only
 *    Required: POST to /api/visits/:visitId/ai-draft with the draft payload
 *              using the doctor's session (not the plugin token)
 *
 * 2. New API route: POST /api/visits/:visitId/ai-draft
 *    Authentication: NextAuth session (doctor must be signed in)
 *    Authorization:  visit must belong to the authenticated doctor
 *    Body: { draftType: DraftType, draftText: string, pluginId: string }
 *    Action: save draft to the EMR (see data model options below)
 *    Response: { saved: true, visitId: string }
 *
 * 3. Data model — two options (decision required before PPMS Core implementation):
 *
 *    Option A — simpler: save to existing Visit.adviseNotes field
 *      Pros: no schema migration, immediate
 *      Cons: overwrites any existing advise notes; no audit of AI origin
 *
 *    Option B — recommended: new Visit.aiDraft JSON field
 *      Schema: aiDraft Json?  (stores { draftType, draftText, confirmedAt, confirmedBy })
 *      Pros: auditable, non-destructive, allows doctor to still edit adviseNotes
 *      Cons: requires Prisma migration
 *
 * 4. Audit log entry (required):
 *    table: PluginAudit
 *    action: "AI_DRAFT_CONFIRMED"
 *    entityId: visitId
 *    entityType: "VISIT"
 *    metadata: { pluginId, draftType, confirmedByDoctorId: doctorId }
 *
 * ─────────────────────────────────────────────────────────────
 * SECURITY NOTE
 * ─────────────────────────────────────────────────────────────
 *
 * PPMS Core must NOT use visitId from the postMessage payload alone.
 * It must cross-check that the visitId belongs to the authenticated doctor's
 * current session to prevent a malicious iframe from submitting drafts for
 * visits the doctor does not own.
 *
 * The Copilot's visitId in the postMessage always comes from the plugin token
 * (set by PPMS Core at token issuance), not from user input — but PPMS Core
 * should still validate ownership on save.
 */

// Re-export the postMessage type for use by future PPMS Core implementation
export type { PluginDraftConfirmedMessage } from "@/postmessage/types";

export type DraftType = "consultation_note" | "follow_up_summary";

// What PPMS Core's new API endpoint should expect in its request body
export type AiDraftSaveRequest = {
  draftType: DraftType;
  draftText: string;
  pluginId: string;
};

// What PPMS Core's new API endpoint should return
export type AiDraftSaveResponse = {
  saved: boolean;
  visitId: string;
};
