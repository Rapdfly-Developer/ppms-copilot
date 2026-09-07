"use client";

// React hook for the postMessage bridge between PPMS Core and the Copilot iframe.
//
// Security model:
//   - Accepts messages ONLY from NEXT_PUBLIC_PPMS_ORIGIN (env var).
//   - Never accepts origin "*".
//   - Silently ignores invalid messages — no error reveals to potential attackers.
//   - Token is stored only in React state (memory), never in localStorage.
//   - All outbound postMessages use targetOrigin = PPMS_ORIGIN (never "*").

import { useEffect, useRef, useState, useCallback } from "react";
import {
  PLUGIN_ID,
  MSG_PLUGIN_READY,
  MSG_PLUGIN_DRAFT_CONFIRMED,
  MSG_PLUGIN_ERROR,
  MSG_PLUGIN_CLOSE,
  MSG_PLUGIN_TOKEN_EXPIRED,
} from "@/lib/constants";
import { validatePpmsInitMessage } from "@/lib/postmessage-validator";
import type { CopilotSession } from "@/types/client";
import type { PluginDraftConfirmedMessage } from "@/postmessage/types";

// Resolved at module load time — the value is embedded by Next.js at build time
// for NEXT_PUBLIC_ variables. It is safe to read here.
const PPMS_ORIGIN = process.env.NEXT_PUBLIC_PPMS_ORIGIN ?? "";

export interface UsePostMessageReturn {
  session: CopilotSession | null;
  confirmDraft: (
    visitId: string,
    draftType: "consultation_note" | "follow_up_summary",
    draftText: string,
  ) => void;
  requestTokenRefresh: () => void;
  sendError: (code: string, message: string) => void;
  sendClose: () => void;
  clearSession: () => void;
}

export function usePostMessage(): UsePostMessageReturn {
  const [session, setSession] = useState<CopilotSession | null>(null);
  // Track the source Window so replies go to the correct frame.
  const parentRef = useRef<MessageEventSource | null>(null);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const result = validatePpmsInitMessage(event.origin, event.data, PPMS_ORIGIN);
      if (!result.ok) return; // Silently ignore — reveal nothing to potential attackers.

      parentRef.current = event.source;

      setSession({
        token: result.message.token,
        visitId: result.message.visitId,
        patientRef: result.message.patientRef,
        initiatedAt: Date.now(),
      });

      // Acknowledge with PLUGIN_READY.
      const readyMsg = { type: MSG_PLUGIN_READY, pluginId: PLUGIN_ID };
      postToParent(readyMsg, event.source);
    }

    window.addEventListener("message", handleMessage);

    // Signal to PPMS Core that the message listener is ready.
    // This resolves the race where PPMS_INIT arrives before React hydration.
    if (PPMS_ORIGIN) {
      window.parent.postMessage({ type: "PLUGIN_MOUNTED", pluginId: PLUGIN_ID }, PPMS_ORIGIN);
    }

    return () => window.removeEventListener("message", handleMessage);
  }, []); // Runs once — PPMS_ORIGIN is stable.

  function postToParent(msg: object, source?: MessageEventSource | null): void {
    const target = source ?? parentRef.current;
    if (!PPMS_ORIGIN) return; // Guard: never send without a known origin.
    if (target) {
      (target as Window).postMessage(msg, PPMS_ORIGIN);
    } else {
      window.parent.postMessage(msg, PPMS_ORIGIN);
    }
  }

  const confirmDraft = useCallback(
    (
      visitId: string,
      draftType: "consultation_note" | "follow_up_summary",
      draftText: string,
    ) => {
      // Token is NOT included — PPMS Core authenticates via its own session cookie.
      const msg: PluginDraftConfirmedMessage = {
        type: MSG_PLUGIN_DRAFT_CONFIRMED,
        pluginId: PLUGIN_ID,
        draftType,
        draftText,
        visitId,
      };
      postToParent(msg);
    },
    [],
  );

  const requestTokenRefresh = useCallback(() => {
    postToParent({ type: MSG_PLUGIN_TOKEN_EXPIRED, pluginId: PLUGIN_ID });
  }, []);

  const sendError = useCallback((code: string, message: string) => {
    postToParent({ type: MSG_PLUGIN_ERROR, pluginId: PLUGIN_ID, code, message });
  }, []);

  const sendClose = useCallback(() => {
    postToParent({ type: MSG_PLUGIN_CLOSE, pluginId: PLUGIN_ID });
  }, []);

  const clearSession = useCallback(() => setSession(null), []);

  return { session, confirmDraft, requestTokenRefresh, sendError, sendClose, clearSession };
}
