// generateCopilot() — consolidated pipeline error classification.
//
// Covers the AI-call failure path specifically: provider.complete() throws
// AiProviderError (from @/ai/provider), a different class from CopilotError
// (from @/lib/errors). The catch block used to check only
// `instanceof CopilotError`, which never matches a real provider failure —
// every AI-call error (rate limit, auth failure, timeout, bad request)
// silently collapsed to the generic AI_UNAVAILABLE fallback, discarding the
// specific, more actionable code the provider layer had already classified.
// This is the same bug identified during the Snapshot investigation and
// fixed here for the consolidated path specifically.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { generateCopilot } from "@/service/copilot-generate";
import { setProvider, resetProvider } from "@/ai";
import * as ppmsClient from "@/lib/ppms-client";
import { AiProviderError } from "@/ai/provider";
import type { AIProvider, AiStreamEvent } from "@/ai/provider";
import {
  FIXTURE_PATIENT,
  FIXTURE_VISIT_CURRENT,
  FIXTURE_VISIT_PREVIOUS,
  FIXTURE_APPOINTMENTS,
  FIXTURE_TIMELINE,
  FIXTURE_TOKEN,
} from "./fixtures/patient";

function makeThrowingProvider(err: unknown): AIProvider {
  return {
    id: "mock",
    model: "mock-model",
    isConfigured: () => true,
    async complete(): Promise<never> {
      throw err;
    },
    async *stream(): AsyncIterable<AiStreamEvent> {
      throw err;
    },
  };
}

beforeEach(() => {
  process.env.PPMS_CORE_URL = "http://ppms-test.internal";
  vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
  vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
  vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([FIXTURE_VISIT_PREVIOUS]);
  vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue(FIXTURE_APPOINTMENTS);
  vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue(FIXTURE_TIMELINE);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProvider();
  delete process.env.PPMS_CORE_URL;
});

describe("generateCopilot() AI-call error classification", () => {
  it("surfaces AiProviderError's actual code (AI_RATE_LIMITED) instead of the generic AI_UNAVAILABLE fallback", async () => {
    setProvider(makeThrowingProvider(new AiProviderError("AI_RATE_LIMITED", "Rate limit exceeded", true)));

    const result = await generateCopilot(`Bearer ${FIXTURE_TOKEN}`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("AI_RATE_LIMITED");
      expect(result.errorCode).not.toBe("AI_UNAVAILABLE");
    }
  });
});
