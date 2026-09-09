"use client";

// Hook that manages a single streaming request to /api/copilot/stream.
//
// Flow: start() → fetch → NDJSON parse → progressive state updates → done/error
// Cancellation: AbortController — cancel() or start() abort any in-flight request.
// Timeout: 60 s hard limit, matching the server's AI_REQUEST_TIMEOUT_MS default.

import { useState, useRef, useCallback } from "react";
import type { StreamState, Capability } from "@/types/client";
import { parseNdjsonStream } from "@/lib/ndjson";
import { COPILOT_STREAM_PATH } from "@/lib/constants";

const REQUEST_TIMEOUT_MS = 60_000;

const IDLE: StreamState = { status: "idle", text: "", warnings: [] };

import type { DoneMeta } from "@/types/client";

type CachedEntry = { text: string; warnings: string[]; doneMeta: DoneMeta };

export interface UseCopilotStreamReturn {
  state: StreamState;
  start: (capability: Capability, token: string, question?: string, cacheKey?: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
  clearCache: () => void;
  deleteCacheEntry: (key: string) => void;
}

export function useCopilotStream(): UseCopilotStreamReturn {
  const [state, setState] = useState<StreamState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  const cacheRef = useRef<Map<string, CachedEntry>>(new Map());

  const start = useCallback(
    async (capability: Capability, token: string, question?: string, cacheKey?: string): Promise<void> => {
      // Serve from cache when available (and cacheKey is provided).
      if (cacheKey) {
        const hit = cacheRef.current.get(cacheKey);
        if (hit) {
          abortRef.current?.abort();
          setState({ status: "done", text: hit.text, warnings: hit.warnings, doneMeta: hit.doneMeta });
          return;
        }
      }

      // Cancel any in-flight request before starting a new one.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      genRef.current += 1;
      const myGen = genRef.current;

      // Only update state if this is still the active request.
      const setStateSafe = (s: StreamState) => {
        if (genRef.current === myGen) setState(s);
      };

      const timeoutId = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      setState({ status: "loading", text: "", warnings: [] });

      try {
        const resp = await fetch(COPILOT_STREAM_PATH, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            capability,
            ...(question ? { question } : {}),
          }),
          signal: ctrl.signal,
        });

        if (!resp.ok || !resp.body) {
          // Non-streaming error response — try to parse a JSON message.
          let errorMessage = "An unexpected error occurred. Please try again.";
          let errorCode = "UNKNOWN_ERROR";
          try {
            const text = await resp.text();
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (typeof parsed.message === "string") errorMessage = parsed.message;
            if (typeof parsed.code === "string") errorCode = parsed.code;
          } catch {
            // Keep defaults.
          }
          setStateSafe({ status: "error", text: "", warnings: [], errorMessage, errorCode });
          return;
        }

        setStateSafe({ status: "streaming", text: "", warnings: [] });

        let accText = "";
        const warnings: string[] = [];

        for await (const frame of parseNdjsonStream(resp.body)) {
          if (ctrl.signal.aborted) break;

          if (frame.type === "text") {
            accText += frame.text;
            setStateSafe({ status: "streaming", text: accText, warnings: [...warnings] });
          } else if (frame.type === "warning") {
            warnings.push(...frame.warnings);
            setStateSafe({ status: "streaming", text: accText, warnings: [...warnings] });
          } else if (frame.type === "done") {
            if (cacheKey && accText) {
              cacheRef.current.set(cacheKey, { text: accText, warnings: [...warnings], doneMeta: frame.meta });
            }
            setStateSafe({
              status: "done",
              text: accText,
              warnings: [...warnings],
              doneMeta: frame.meta,
            });
            return;
          } else if (frame.type === "error") {
            setStateSafe({
              status: "error",
              text: frame.discard ? "" : accText,
              warnings: [...warnings],
              errorMessage: frame.message,
              errorCode: frame.code,
            });
            return;
          }
        }

        // Stream ended without a done/error frame.
        if (!ctrl.signal.aborted) {
          setStateSafe({ status: "done", text: accText, warnings: [...warnings] });
        } else {
          setStateSafe({ status: "cancelled", text: "", warnings: [] });
        }
      } catch (err: unknown) {
        if (ctrl.signal.aborted) {
          setStateSafe({ status: "cancelled", text: "", warnings: [] });
          return;
        }
        const isTimeout =
          err instanceof DOMException && err.name === "AbortError";
        setStateSafe({
          status: "error",
          text: "",
          warnings: [],
          errorMessage: isTimeout
            ? "The request timed out. Please try again."
            : "Connection failed. Please try again.",
          errorCode: isTimeout ? "TIMEOUT" : "STREAM_FAILED",
        });
      } finally {
        clearTimeout(timeoutId);
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState(IDLE);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(IDLE);
  }, []);

  const clearCache = useCallback(() => {
    cacheRef.current.clear();
  }, []);

  const deleteCacheEntry = useCallback((key: string) => {
    cacheRef.current.delete(key);
  }, []);

  return { state, start, cancel, reset, clearCache, deleteCacheEntry } as const;
}
