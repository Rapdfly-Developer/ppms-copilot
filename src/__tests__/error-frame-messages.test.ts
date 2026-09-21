// errorFrame (service/copilot.ts) — regression suite for a real production
// bug: every validation failure on the standalone stream path used to be
// force-mapped to the generic RESPONSE_VALIDATION_FAILED wording ("AI
// response did not meet clinical safety requirements"), regardless of the
// actual code (RESPONSE_EMPTY, RESPONSE_TRUNCATED, RESPONSE_UNSAFE, any
// *_STRUCTURE_INVALID code). Found while live-debugging an EXAM_GUIDANCE
// failure that turned out to be a boring maxTokens truncation, misreported
// as a "clinical safety" rejection.
//
// errorFrame() itself is not exported — this exercises it through the public
// streamCopilotResponse() pipeline, the same way capability-service.test.ts does.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { streamCopilotResponse } from "@/service/copilot";
import { setProvider, resetProvider } from "@/ai";
import * as ppmsClient from "@/lib/ppms-client";
import { USER_MESSAGES } from "@/lib/errors";
import type { AIProvider, AiResult, AiStreamEvent } from "@/ai/provider";
import {
  FIXTURE_PATIENT,
  FIXTURE_VISIT_CURRENT,
  FIXTURE_VISIT_PREVIOUS,
  FIXTURE_APPOINTMENTS,
  FIXTURE_TIMELINE,
  FIXTURE_TOKEN,
} from "./fixtures/patient";

function makeMockProvider(responseText: string, stopReason = "end_turn"): AIProvider {
  return {
    id: "mock",
    model: "mock-model",
    isConfigured: () => true,
    async complete(): Promise<AiResult> {
      return {
        text: responseText,
        model: "mock-model",
        provider: "mock",
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason,
      };
    },
    async *stream(): AsyncIterable<AiStreamEvent> {
      yield { type: "text", text: responseText };
      yield {
        type: "done",
        model: "mock-model",
        provider: "mock",
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason,
      };
    },
  };
}

async function firstErrorFrame(
  body: Record<string, unknown>,
): Promise<{ code: string; message: string } | null> {
  for await (const frame of streamCopilotResponse(body, `Bearer ${FIXTURE_TOKEN}`)) {
    if (frame.type === "error") return { code: frame.code, message: frame.message };
  }
  return null;
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

describe("errorFrame surfaces the real per-code message, not a forced generic one", () => {
  it("RESPONSE_EMPTY gets its own message", async () => {
    setProvider(makeMockProvider(""));

    const err = await firstErrorFrame({ capability: "PATIENT_SNAPSHOT" });

    expect(err?.code).toBe("RESPONSE_EMPTY");
    expect(err?.message).toBe(USER_MESSAGES.RESPONSE_EMPTY);
    expect(err?.message).not.toBe(USER_MESSAGES.RESPONSE_VALIDATION_FAILED);
  });

  it("RESPONSE_TRUNCATED gets its own message — the exact bug found live-debugging EXAM_GUIDANCE", async () => {
    setProvider(makeMockProvider("This looks like a perfectly reasonable response.", "max_tokens"));

    const err = await firstErrorFrame({ capability: "PATIENT_SNAPSHOT" });

    expect(err?.code).toBe("RESPONSE_TRUNCATED");
    expect(err?.message).toBe(USER_MESSAGES.RESPONSE_TRUNCATED);
    expect(err?.message).not.toBe(USER_MESSAGES.RESPONSE_VALIDATION_FAILED);
  });

  it("RESPONSE_UNSAFE gets its own message", async () => {
    setProvider(makeMockProvider("I recommend you take this medication immediately."));

    const err = await firstErrorFrame({ capability: "PATIENT_SNAPSHOT" });

    expect(err?.code).toBe("RESPONSE_UNSAFE");
    expect(err?.message).toBe(USER_MESSAGES.RESPONSE_UNSAFE);
    expect(err?.message).not.toBe(USER_MESSAGES.RESPONSE_VALIDATION_FAILED);
  });

  it("EXAM_GUIDANCE_STRUCTURE_INVALID gets its own message", async () => {
    setProvider(
      makeMockProvider(
        "Some free text with no block-shaped content at all, well past the minimum length.",
      ),
    );

    const err = await firstErrorFrame({ capability: "EXAM_GUIDANCE" });

    expect(err?.code).toBe("EXAM_GUIDANCE_STRUCTURE_INVALID");
    expect(err?.message).toBe(USER_MESSAGES.EXAM_GUIDANCE_STRUCTURE_INVALID);
    expect(err?.message).not.toBe(USER_MESSAGES.RESPONSE_VALIDATION_FAILED);
  });

  it("different failure codes produce genuinely different messages from each other", async () => {
    setProvider(makeMockProvider(""));
    const empty = await firstErrorFrame({ capability: "PATIENT_SNAPSHOT" });
    resetProvider();

    setProvider(makeMockProvider("I recommend you take this medication immediately."));
    const unsafe = await firstErrorFrame({ capability: "PATIENT_SNAPSHOT" });

    // Before the fix, both of these collapsed to the same forced generic text.
    expect(empty?.message).not.toBe(unsafe?.message);
  });
});
