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

export interface UseCopilotStreamReturn {
  state: StreamState;
  start: (capability: Capability, token: string, question?: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useCopilotStream(): UseCopilotStreamReturn {
  const [state, setState] = useState<StreamState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (capability: Capability, token: string, question?: string): Promise<void> => {
      // Cancel any in-flight request before starting a new one.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

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
          setState({ status: "error", text: "", warnings: [], errorMessage, errorCode });
          return;
        }

        setState({ status: "streaming", text: "", warnings: [] });

        let accText = "";
        const warnings: string[] = [];

        for await (const frame of parseNdjsonStream(resp.body)) {
          if (ctrl.signal.aborted) break;

          if (frame.type === "text") {
            accText += frame.text;
            setState({ status: "streaming", text: accText, warnings: [...warnings] });
          } else if (frame.type === "warning") {
            warnings.push(...frame.warnings);
            setState({ status: "streaming", text: accText, warnings: [...warnings] });
          } else if (frame.type === "done") {
            setState({
              status: "done",
              text: accText,
              warnings: [...warnings],
              doneMeta: frame.meta,
            });
            return;
          } else if (frame.type === "error") {
            setState({
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
          setState({ status: "done", text: accText, warnings: [...warnings] });
        } else {
          setState({ status: "cancelled", text: "", warnings: [] });
        }
      } catch (err: unknown) {
        if (ctrl.signal.aborted) {
          setState({ status: "cancelled", text: "", warnings: [] });
          return;
        }
        const isTimeout =
          err instanceof DOMException && err.name === "AbortError";
        setState({
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

  return { state, start, cancel, reset };
}
