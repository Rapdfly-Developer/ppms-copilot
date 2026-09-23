"use client";

// React hook for the postMessage bridge between PPMS Core and the Copilot iframe.
//
// Security model:
//   - Accepts messages ONLY from NEXT_PUBLIC_PPMS_ORIGIN (env var).
//   - Never accepts origin "*".
//   - Silently ignores invalid messages — no error reveals to potential attackers.
//   - Token is stored only in React state (memory), never in localStorage.
//   - All outbound postMessages use targetOrigin = PPMS_ORIGIN (never "*").
//   - PPMS_REQUEST_EXAM_GUIDANCE and PPMS_REQUEST_REFRACTIVE_GUIDANCE (the
//     only other inbound messages besides PPMS_INIT) additionally require
//     their visitId to match the session already established by PPMS_INIT —
//     a stale/mismatched trigger is silently ignored rather than generating
//     for the wrong visit.

import { useEffect, useRef, useState, useCallback } from "react";
import {
  PLUGIN_ID,
  MSG_PLUGIN_READY,
  MSG_PLUGIN_DRAFT_CONFIRMED,
  MSG_PLUGIN_ERROR,
  MSG_PLUGIN_CLOSE,
  MSG_PLUGIN_TOKEN_EXPIRED,
  MSG_PLUGIN_DIFFERENTIAL_UPDATE,
  MSG_PLUGIN_EXAM_GUIDANCE_RESULT,
  MSG_PLUGIN_REFRACTIVE_GUIDANCE_RESULT,
  MSG_PLUGIN_PLAN_GUIDANCE_UPDATE,
  MSG_PLUGIN_ASSESSMENT_UPDATE,
  MSG_PLUGIN_INVESTIGATION_GUIDANCE_UPDATE,
} from "@/lib/constants";
import {
  validatePpmsInitMessage,
  validateRequestExamGuidanceMessage,
  validateRequestRefractiveGuidanceMessage,
} from "@/lib/postmessage-validator";
import type {
  CopilotSession,
  DifferentialDiagnosisItem,
  DiagnosisComparisonResult,
  ExamGuidanceSection,
  RefractiveGuidanceResult,
  PlanGuidanceResult,
  InvestigationGuidanceResult,
} from "@/types/client";
import type {
  PluginDraftConfirmedMessage,
  PluginDifferentialUpdateMessage,
  PluginExamGuidanceResultMessage,
  PluginRefractiveGuidanceResultMessage,
  PluginPlanGuidanceUpdateMessage,
  PluginAssessmentUpdateMessage,
  PluginInvestigationGuidanceUpdateMessage,
} from "@/postmessage/types";

// Resolved at module load time — the value is embedded by Next.js at build time
// for NEXT_PUBLIC_ variables. It is safe to read here.
const PPMS_ORIGIN = process.env.NEXT_PUBLIC_PPMS_ORIGIN ?? "";

// One PPMS_REQUEST_EXAM_GUIDANCE received. requestedAt (Date.now()) is a
// change-detection key for the consuming effect — distinct from visitId
// because the doctor could trigger the same visit's exam guidance more than
// once (e.g. after documenting more of the General tab). `token`, when
// present, is the fresh plugin token PPMS Core minted for this specific
// trigger — see lib/on-demand-token.ts for why the consumer must prefer it
// over the original session token.
export type ExamGuidanceRequest = { visitId: string; token?: string; requestedAt: number };

export type ExamGuidanceResult =
  | { ok: true; sections: ExamGuidanceSection[] }
  | { ok: false; errorCode: string; errorMessage: string };

// Same shape as ExamGuidanceRequest — see its comment for why requestedAt
// and token exist.
export type RefractiveGuidanceRequest = { visitId: string; token?: string; requestedAt: number };

export type RefractiveGuidanceOutcome =
  | { ok: true; result: RefractiveGuidanceResult }
  | { ok: false; errorCode: string; errorMessage: string };

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
  sendDifferentialUpdate: (visitId: string, items: DifferentialDiagnosisItem[]) => void;
  examGuidanceRequest: ExamGuidanceRequest | null;
  sendExamGuidanceResult: (visitId: string, result: ExamGuidanceResult) => void;
  refractiveGuidanceRequest: RefractiveGuidanceRequest | null;
  sendRefractiveGuidanceResult: (visitId: string, result: RefractiveGuidanceOutcome) => void;
  sendPlanGuidanceUpdate: (visitId: string, result: PlanGuidanceResult) => void;
  sendAssessmentUpdate: (visitId: string, assessmentContext: string, diagnosisComparison?: DiagnosisComparisonResult) => void;
  sendInvestigationGuidanceUpdate: (visitId: string, result: InvestigationGuidanceResult) => void;
}

export function usePostMessage(): UsePostMessageReturn {
  const [session, setSession] = useState<CopilotSession | null>(null);
  const [examGuidanceRequest, setExamGuidanceRequest] = useState<ExamGuidanceRequest | null>(null);
  const [refractiveGuidanceRequest, setRefractiveGuidanceRequest] =
    useState<RefractiveGuidanceRequest | null>(null);
  // Track the source Window so replies go to the correct frame.
  const parentRef = useRef<MessageEventSource | null>(null);
  // Mirrors `session` for use inside handleMessage, which is registered once
  // (effect deps: []) and would otherwise close over a stale `session`.
  const sessionRef = useRef<CopilotSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let sessionReceived = false;

    function handleMessage(event: MessageEvent) {
      const initResult = validatePpmsInitMessage(event.origin, event.data, PPMS_ORIGIN);
      if (initResult.ok) {
        sessionReceived = true;
        parentRef.current = event.source;

        // Only create a new session (and trigger auto-start) when the visit changes.
        // Repeated PPMS_INIT for the same visit (e.g. from the PLUGIN_MOUNTED retry
        // loop) must not re-fire auto-start and burn another AI call.
        setSession((prev) => {
          if (
            prev?.visitId === initResult.message.visitId &&
            prev?.patientRef === initResult.message.patientRef
          ) {
            return prev;
          }
          return {
            token: initResult.message.token,
            visitId: initResult.message.visitId,
            patientRef: initResult.message.patientRef,
            initiatedAt: Date.now(),
          };
        });

        // Acknowledge with PLUGIN_READY.
        const readyMsg = { type: MSG_PLUGIN_READY, pluginId: PLUGIN_ID };
        postToParent(readyMsg, event.source);
        return;
      }

      // Not a PPMS_INIT — try the on-demand EXAM_GUIDANCE trigger. Requires
      // visitId to match the session already established by PPMS_INIT (see
      // validateRequestExamGuidanceMessage) — silently ignored otherwise,
      // same fail-closed posture as an invalid PPMS_INIT.
      const examResult = validateRequestExamGuidanceMessage(
        event.origin,
        event.data,
        PPMS_ORIGIN,
        sessionRef.current?.visitId ?? null,
      );
      if (examResult.ok) {
        setExamGuidanceRequest({
          visitId: examResult.message.visitId,
          token: examResult.message.token,
          requestedAt: Date.now(),
        });
        return;
      }

      // Not an EXAM_GUIDANCE trigger either — try the on-demand
      // REFRACTIVE_GUIDANCE trigger, same fail-closed posture.
      const refractiveResult = validateRequestRefractiveGuidanceMessage(
        event.origin,
        event.data,
        PPMS_ORIGIN,
        sessionRef.current?.visitId ?? null,
      );
      if (refractiveResult.ok) {
        setRefractiveGuidanceRequest({
          visitId: refractiveResult.message.visitId,
          token: refractiveResult.message.token,
          requestedAt: Date.now(),
        });
      }
    }

    window.addEventListener("message", handleMessage);

    // Signal to PPMS Core that the message listener is ready.
    // Retry every 1.5 s until PPMS_INIT arrives — resolves the race where
    // PPMS Core's onMounted listener hasn't registered yet when the first
    // PLUGIN_MOUNTED fires (can happen during PPMS page hydration).
    function sendMounted() {
      if (PPMS_ORIGIN) {
        window.parent.postMessage({ type: "PLUGIN_MOUNTED", pluginId: PLUGIN_ID }, PPMS_ORIGIN);
      }
    }
    sendMounted();
    const retryInterval = setInterval(() => {
      if (sessionReceived) {
        clearInterval(retryInterval);
        return;
      }
      sendMounted();
    }, 1500);

    return () => {
      window.removeEventListener("message", handleMessage);
      clearInterval(retryInterval);
    };
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

  // Token is NOT included — same posture as confirmDraft. Only visitId plus
  // the diagnosis list the doctor is already seeing in the Copilot's own tab.
  const sendDifferentialUpdate = useCallback(
    (visitId: string, items: DifferentialDiagnosisItem[]) => {
      const msg: PluginDifferentialUpdateMessage = {
        type: MSG_PLUGIN_DIFFERENTIAL_UPDATE,
        pluginId: PLUGIN_ID,
        visitId,
        items,
      };
      postToParent(msg);
    },
    [],
  );

  // Token is NOT included — same posture as sendDifferentialUpdate. Sent once
  // per PPMS_REQUEST_EXAM_GUIDANCE, whether the on-demand generation it
  // triggered succeeded or failed.
  const sendExamGuidanceResult = useCallback((visitId: string, result: ExamGuidanceResult) => {
    const msg: PluginExamGuidanceResultMessage = result.ok
      ? { type: MSG_PLUGIN_EXAM_GUIDANCE_RESULT, pluginId: PLUGIN_ID, visitId, ok: true, sections: result.sections }
      : {
          type: MSG_PLUGIN_EXAM_GUIDANCE_RESULT,
          pluginId: PLUGIN_ID,
          visitId,
          ok: false,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        };
    postToParent(msg);
  }, []);

  // Token is NOT included — same posture as sendExamGuidanceResult. Sent once
  // per PPMS_REQUEST_REFRACTIVE_GUIDANCE, whether the on-demand generation it
  // triggered succeeded or failed.
  const sendRefractiveGuidanceResult = useCallback(
    (visitId: string, result: RefractiveGuidanceOutcome) => {
      const msg: PluginRefractiveGuidanceResultMessage = result.ok
        ? {
            type: MSG_PLUGIN_REFRACTIVE_GUIDANCE_RESULT,
            pluginId: PLUGIN_ID,
            visitId,
            ok: true,
            result: result.result,
          }
        : {
            type: MSG_PLUGIN_REFRACTIVE_GUIDANCE_RESULT,
            pluginId: PLUGIN_ID,
            visitId,
            ok: false,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
          };
      postToParent(msg);
    },
    [],
  );

  // Token is NOT included — same posture as sendDifferentialUpdate. Sent once
  // per successful consolidated generation (and again after Regenerate) once
  // planGuidance validates successfully. Message type and payload shape
  // (`result`, not `sections`/`items`) match PPMS Core's already-implemented
  // receiver contract exactly.
  const sendPlanGuidanceUpdate = useCallback((visitId: string, result: PlanGuidanceResult) => {
    const msg: PluginPlanGuidanceUpdateMessage = {
      type: MSG_PLUGIN_PLAN_GUIDANCE_UPDATE,
      pluginId: PLUGIN_ID,
      visitId,
      result,
    };
    postToParent(msg);
  }, []);

  // Token is NOT included — same posture as sendDifferentialUpdate. Pure
  // reuse: `assessmentContext` is the exact already-validated
  // ASSESSMENT_CONTEXT text, not new content.
  const sendAssessmentUpdate = useCallback((visitId: string, assessmentContext: string, diagnosisComparison?: DiagnosisComparisonResult) => {
    const msg: PluginAssessmentUpdateMessage = {
      type: MSG_PLUGIN_ASSESSMENT_UPDATE,
      pluginId: PLUGIN_ID,
      visitId,
      assessmentContext,
      ...(diagnosisComparison ? { diagnosisComparison } : {}),
    };
    postToParent(msg);
  }, []);

  // Token is NOT included — same posture as sendDifferentialUpdate/
  // sendPlanGuidanceUpdate. Sent once per successful consolidated generation
  // (and again after Regenerate) once investigationGuidance validates
  // successfully.
  const sendInvestigationGuidanceUpdate = useCallback(
    (visitId: string, result: InvestigationGuidanceResult) => {
      const msg: PluginInvestigationGuidanceUpdateMessage = {
        type: MSG_PLUGIN_INVESTIGATION_GUIDANCE_UPDATE,
        pluginId: PLUGIN_ID,
        visitId,
        result,
      };
      postToParent(msg);
    },
    [],
  );

  return {
    session,
    confirmDraft,
    requestTokenRefresh,
    sendError,
    sendClose,
    clearSession,
    sendDifferentialUpdate,
    examGuidanceRequest,
    sendExamGuidanceResult,
    refractiveGuidanceRequest,
    sendRefractiveGuidanceResult,
    sendPlanGuidanceUpdate,
    sendAssessmentUpdate,
    sendInvestigationGuidanceUpdate,
  };
}
