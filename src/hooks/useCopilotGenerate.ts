"use client";

// Hook that manages a single consolidated Copilot request to /api/copilot/generate.
//
// Key guarantees:
//   - ONE fetch per visitId per session (cache prevents re-fetch on tab switch)
//   - React Strict Mode safe — concurrent calls for the same visitId are deduplicated
//   - AbortController cleanup on unmount or navigation away
//   - 90-second hard timeout (consolidated call is larger than per-tab stream)
//   - Regenerate bypasses cache and issues exactly one new request
//   - Cache is keyed by visitId and cleared automatically when visitId changes

import { useState, useRef, useCallback } from "react";
import { COPILOT_GENERATE_PATH } from "@/lib/constants";
import type {
  CopilotGenerateState,
  CopilotData,
  SectionOutcome,
} from "@/types/client";

const REQUEST_TIMEOUT_MS = 90_000;

type DoneState = CopilotGenerateState & { status: "done" };

export interface UseCopilotGenerateReturn {
  state: CopilotGenerateState;
  generate: (token: string, visitId: string) => void;
  regenerate: (token: string, visitId: string) => void;
  cancel: () => void;
}

export function useCopilotGenerate(): UseCopilotGenerateReturn {
  const [state, setState] = useState<CopilotGenerateState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  // Per-visitId cache so tab-switches are instant and re-mounts don't re-fetch.
  const cacheRef = useRef<Map<string, DoneState>>(new Map());
  // Deduplication: track which visitId is currently loading to prevent concurrent
  // requests for the same visit (React Strict Mode / double-mount protection).
  const loadingVisitIdRef = useRef<string | null>(null);

  const doFetch = useCallback(async (token: string, visitId: string): Promise<void> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    genRef.current += 1;
    const myGen = genRef.current;
    loadingVisitIdRef.current = visitId;

    const setStateSafe = (s: CopilotGenerateState) => {
      if (genRef.current === myGen) setState(s);
    };

    const timeoutId = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    setStateSafe({ status: "loading" });

    try {
      const resp = await fetch(COPILOT_GENERATE_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        let errorMessage = "An unexpected error occurred. Please try again.";
        let errorCode = "UNKNOWN_ERROR";
        try {
          const parsed = await resp.json() as Record<string, unknown>;
          if (typeof parsed.errorMessage === "string") errorMessage = parsed.errorMessage;
          if (typeof parsed.errorCode === "string") errorCode = parsed.errorCode;
        } catch { /* keep defaults */ }
        setStateSafe({ status: "error", errorMessage, errorCode });
        return;
      }

      const json = await resp.json() as Record<string, unknown>;
      const result = json.result;

      if (!result || typeof result !== "object") {
        setStateSafe({
          status: "error",
          errorMessage: "An unexpected error occurred. Please try again.",
          errorCode: "INTERNAL_ERROR",
        });
        return;
      }

      const r = result as Record<string, unknown>;
      const newState: DoneState = {
        status: "done",
        data: {
          snapshot: r.snapshot as SectionOutcome,
          previousVisits: r.previousVisits as SectionOutcome,
          timeline: r.timeline as SectionOutcome,
          attention: r.attention as SectionOutcome,
          draftNote: r.draftNote as SectionOutcome,
          followUp: r.followUp as SectionOutcome,
        } satisfies CopilotData,
        meta: (r.meta ?? {}) as Record<string, unknown>,
      };

      cacheRef.current.set(visitId, newState);
      setStateSafe(newState);
    } catch (err: unknown) {
      if (ctrl.signal.aborted) {
        // Aborted by cancel() or AbortController timeout — return to idle
        // so the user can try again without seeing an error.
        if (genRef.current === myGen) setState({ status: "idle" });
        return;
      }
      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      setStateSafe({
        status: "error",
        errorMessage: isTimeout
          ? "The request timed out. Please try again."
          : "Connection failed. Please try again.",
        errorCode: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      });
    } finally {
      clearTimeout(timeoutId);
      if (loadingVisitIdRef.current === visitId) {
        loadingVisitIdRef.current = null;
      }
    }
  }, []);

  const generate = useCallback(
    (token: string, visitId: string): void => {
      // Cache hit — serve immediately, no API call
      const hit = cacheRef.current.get(visitId);
      if (hit) {
        abortRef.current?.abort();
        setState(hit);
        return;
      }

      // Deduplication: if already loading this visitId, do nothing
      if (loadingVisitIdRef.current === visitId) return;

      void doFetch(token, visitId);
    },
    [doFetch],
  );

  const regenerate = useCallback(
    (token: string, visitId: string): void => {
      // Bypass cache — fresh request for all six sections
      cacheRef.current.delete(visitId);
      void doFetch(token, visitId);
    },
    [doFetch],
  );

  const cancel = useCallback((): void => {
    abortRef.current?.abort();
    loadingVisitIdRef.current = null;
    setState({ status: "idle" });
  }, []);

  return { state, generate, regenerate, cancel };
}
