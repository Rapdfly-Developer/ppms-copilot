import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { streamCopilotResponse } from "@/service/copilot";
import { setProvider, resetProvider } from "@/ai";
import * as ppmsClient from "@/lib/ppms-client";
import type { AIProvider, AiRequest, AiResult, AiStreamEvent } from "@/ai/provider";
import type { NdjsonFrame } from "@/service/copilot";
import {
  FIXTURE_PATIENT,
  FIXTURE_VISIT_CURRENT,
  FIXTURE_VISIT_PREVIOUS,
  FIXTURE_APPOINTMENTS,
  FIXTURE_TIMELINE,
  FIXTURE_TOKEN,
} from "./fixtures/patient";

// ── Mock AI provider ──────────────────────────────────────────────────────────
// All tests use mocked AI — no real Anthropic API calls.

function makeMockProvider(responseText: string): AIProvider {
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
        stopReason: "end_turn",
      };
    },
    async *stream(): AsyncIterable<AiStreamEvent> {
      // Stream the text in three chunks
      const third = Math.ceil(responseText.length / 3);
      yield { type: "text", text: responseText.slice(0, third) };
      yield { type: "text", text: responseText.slice(third, third * 2) };
      yield { type: "text", text: responseText.slice(third * 2) };
      yield {
        type: "done",
        model: "mock-model",
        provider: "mock",
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      };
    },
  };
}

// Safe ophthalmology summary with all required SOAP sections for NOTE_ASSISTANCE
const SAFE_SNAPSHOT = `## DEMOGRAPHICS
52-year-old male, Glaucoma category.
Chief complaint: Blurred vision right eye.

## CURRENT VISIT
Active diagnoses: Primary open-angle glaucoma (documented, confirmed).
Medications: Timolol 0.5% eye drops, both eyes, twice daily.`;

const SAFE_PREVIOUS_VISIT = `## PREVIOUS VISIT (2023-12-10)
Chief complaint: Blurred vision.
Diagnoses: Primary open-angle glaucoma (H40.11) - confirmed.
Medications: Timolol 0.5% continued.`;

const SAFE_TIMELINE = `## CLINICAL TIMELINE
2024-01-15 — Outpatient visit: Chief complaint blurred vision right eye.
2023-12-10 — Previous outpatient visit: Glaucoma management review.`;

const SAFE_CHANGES = `## DOCUMENTED CHANGES
Documented change: Current visit chief complaint is blurred vision right eye.
Consider reviewing: Glaucoma status as documented.`;

const SAFE_SOAP_NOTE = `**Subjective:**
Patient presents with blurred vision in the right eye as documented.

**Objective:**
Documented findings: Primary open-angle glaucoma (H40.11) confirmed status.
Current medication: Timolol 0.5% eye drops bilateral.

**Assessment:**
Documented diagnosis: Primary open-angle glaucoma (H40.11), confirmed.

**Plan:**
Continue current documented treatment. Follow-up as per documented advice.`;

const SAFE_FOLLOWUP = `## FOLLOW-UP SUMMARY
Patient summary: 52-year-old male with documented glaucoma.
Current diagnoses: Primary open-angle glaucoma (H40.11) - confirmed.
Treatment plan: As documented in current visit record.
Next steps: As documented.`;

async function collectFrames(
  body: Record<string, unknown>,
  authHeader: string,
): Promise<NdjsonFrame[]> {
  const frames: NdjsonFrame[] = [];
  for await (const frame of streamCopilotResponse(body, authHeader)) {
    frames.push(frame);
  }
  return frames;
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.PPMS_CORE_URL = "http://ppms-test.internal";

  // Default mock: patient + current visit (always needed)
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

// ── PATIENT_SNAPSHOT ──────────────────────────────────────────────────────────

describe("PATIENT_SNAPSHOT capability", () => {
  it("streams text frames then a done frame", async () => {
    setProvider(makeMockProvider(SAFE_SNAPSHOT));

    const frames = await collectFrames({ capability: "PATIENT_SNAPSHOT" }, `Bearer ${FIXTURE_TOKEN}`);

    const textFrames = frames.filter((f) => f.type === "text");
    const doneFrames = frames.filter((f) => f.type === "done");
    const errorFrames = frames.filter((f) => f.type === "error");

    expect(errorFrames).toHaveLength(0);
    expect(textFrames.length).toBeGreaterThan(0);
    expect(doneFrames).toHaveLength(1);
    expect(frames[frames.length - 1].type).toBe("done");
  });

  it("done frame includes capability and producesDraft:false", async () => {
    setProvider(makeMockProvider(SAFE_SNAPSHOT));

    const frames = await collectFrames({ capability: "PATIENT_SNAPSHOT" }, `Bearer ${FIXTURE_TOKEN}`);
    const done = frames.find((f) => f.type === "done");

    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.meta.capability).toBe("PATIENT_SNAPSHOT");
      expect(done.meta.producesDraft).toBe(false);
    }
  });

  it("accumulated text matches the mock AI output", async () => {
    setProvider(makeMockProvider(SAFE_SNAPSHOT));

    const frames = await collectFrames({ capability: "PATIENT_SNAPSHOT" }, `Bearer ${FIXTURE_TOKEN}`);
    const accumulated = frames
      .filter((f): f is { type: "text"; text: string } => f.type === "text")
      .map((f) => f.text)
      .join("");

    expect(accumulated).toBe(SAFE_SNAPSHOT);
  });

  it("only fetches patient and current visit — not full history", async () => {
    setProvider(makeMockProvider(SAFE_SNAPSHOT));
    const getVisitsSpy = vi.spyOn(ppmsClient, "getVisits");

    await collectFrames({ capability: "PATIENT_SNAPSHOT" }, `Bearer ${FIXTURE_TOKEN}`);

    expect(getVisitsSpy).not.toHaveBeenCalled();
  });
});

// ── PREVIOUS_VISIT_SUMMARY ────────────────────────────────────────────────────

describe("PREVIOUS_VISIT_SUMMARY capability", () => {
  it("streams text then done frame", async () => {
    setProvider(makeMockProvider(SAFE_PREVIOUS_VISIT));

    const frames = await collectFrames({ capability: "PREVIOUS_VISIT_SUMMARY" }, `Bearer ${FIXTURE_TOKEN}`);

    expect(frames.some((f) => f.type === "text")).toBe(true);
    expect(frames[frames.length - 1].type).toBe("done");
  });

  it("done frame has producesDraft:false", async () => {
    setProvider(makeMockProvider(SAFE_PREVIOUS_VISIT));

    const frames = await collectFrames({ capability: "PREVIOUS_VISIT_SUMMARY" }, `Bearer ${FIXTURE_TOKEN}`);
    const done = frames.find((f) => f.type === "done");

    if (done?.type === "done") {
      expect(done.meta.producesDraft).toBe(false);
    }
  });

  it("fetches visit history (getVisits called)", async () => {
    setProvider(makeMockProvider(SAFE_PREVIOUS_VISIT));
    const getVisitsSpy = vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([FIXTURE_VISIT_PREVIOUS]);

    await collectFrames({ capability: "PREVIOUS_VISIT_SUMMARY" }, `Bearer ${FIXTURE_TOKEN}`);

    expect(getVisitsSpy).toHaveBeenCalled();
  });
});

// ── TIMELINE_SUMMARY ──────────────────────────────────────────────────────────

describe("TIMELINE_SUMMARY capability", () => {
  it("streams text then done frame", async () => {
    setProvider(makeMockProvider(SAFE_TIMELINE));

    const frames = await collectFrames({ capability: "TIMELINE_SUMMARY" }, `Bearer ${FIXTURE_TOKEN}`);

    expect(frames.some((f) => f.type === "text")).toBe(true);
    expect(frames[frames.length - 1].type).toBe("done");
  });

  it("fetches timeline and appointments", async () => {
    setProvider(makeMockProvider(SAFE_TIMELINE));
    const getTimelineSpy = vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue(FIXTURE_TIMELINE);
    const getAppointmentsSpy = vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue(FIXTURE_APPOINTMENTS);

    await collectFrames({ capability: "TIMELINE_SUMMARY" }, `Bearer ${FIXTURE_TOKEN}`);

    expect(getTimelineSpy).toHaveBeenCalled();
    expect(getAppointmentsSpy).toHaveBeenCalled();
  });
});

// ── IMPORTANT_CHANGES ─────────────────────────────────────────────────────────

describe("IMPORTANT_CHANGES capability", () => {
  it("streams text then done frame", async () => {
    setProvider(makeMockProvider(SAFE_CHANGES));

    const frames = await collectFrames({ capability: "IMPORTANT_CHANGES" }, `Bearer ${FIXTURE_TOKEN}`);

    expect(frames.some((f) => f.type === "text")).toBe(true);
    expect(frames[frames.length - 1].type).toBe("done");
    expect(frames.filter((f) => f.type === "error")).toHaveLength(0);
  });
});

// ── NOTE_ASSISTANCE (draft) ───────────────────────────────────────────────────

describe("NOTE_ASSISTANCE capability", () => {
  it("done frame has producesDraft:true and draftType:consultation_note", async () => {
    setProvider(makeMockProvider(SAFE_SOAP_NOTE));

    const frames = await collectFrames({ capability: "NOTE_ASSISTANCE" }, `Bearer ${FIXTURE_TOKEN}`);
    const done = frames.find((f) => f.type === "done");

    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.meta.producesDraft).toBe(true);
      expect(done.meta.draftType).toBe("consultation_note");
    }
  });

  it("draft output includes all four SOAP sections", async () => {
    setProvider(makeMockProvider(SAFE_SOAP_NOTE));

    const frames = await collectFrames({ capability: "NOTE_ASSISTANCE" }, `Bearer ${FIXTURE_TOKEN}`);
    const text = frames
      .filter((f): f is { type: "text"; text: string } => f.type === "text")
      .map((f) => f.text)
      .join("");

    expect(text).toContain("Subjective");
    expect(text).toContain("Objective");
    expect(text).toContain("Assessment");
    expect(text).toContain("Plan");
  });

  it("rejects AI output that issues a direct prescription (hallucination safeguard)", async () => {
    const UNSAFE_AI = "I recommend you prescribe latanoprost eye drops immediately.";
    setProvider(makeMockProvider(UNSAFE_AI));

    const frames = await collectFrames({ capability: "NOTE_ASSISTANCE" }, `Bearer ${FIXTURE_TOKEN}`);

    // Validation must reject this output — error frame expected.
    expect(frames.some((f) => f.type === "error")).toBe(true);
    expect(frames.find((f) => f.type === "done")).toBeUndefined();
  });

  it("rejects AI output that states a definitive new diagnosis", async () => {
    const UNSAFE_AI = "The diagnosis is primary open-angle glaucoma with macular degeneration.\n\n**Subjective:**\nPatient presents.\n**Objective:**\nFindings.\n**Assessment:**\nGlaucoma.\n**Plan:**\nContinue.";
    setProvider(makeMockProvider(UNSAFE_AI));

    const frames = await collectFrames({ capability: "NOTE_ASSISTANCE" }, `Bearer ${FIXTURE_TOKEN}`);
    expect(frames.some((f) => f.type === "error")).toBe(true);
  });
});

// ── FOLLOW_UP_SUMMARY (draft) ─────────────────────────────────────────────────

describe("FOLLOW_UP_SUMMARY capability", () => {
  it("done frame has producesDraft:true and draftType:follow_up_summary", async () => {
    setProvider(makeMockProvider(SAFE_FOLLOWUP));

    const frames = await collectFrames({ capability: "FOLLOW_UP_SUMMARY" }, `Bearer ${FIXTURE_TOKEN}`);
    const done = frames.find((f) => f.type === "done");

    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.meta.producesDraft).toBe(true);
      expect(done.meta.draftType).toBe("follow_up_summary");
    }
  });
});

// ── AI hallucination safeguards ───────────────────────────────────────────────

describe("AI hallucination safeguards", () => {
  const UNSAFE_OUTPUTS = [
    { label: "prescribe", text: "I prescribe latanoprost for this patient." },
    { label: "recommend medication", text: "I recommend you start timolol eye drops." },
    { label: "change dose", text: "Change the dose to 20mg daily." },
    { label: "add specific drug", text: "Add timolol to the regimen." },
  ];

  for (const { label, text } of UNSAFE_OUTPUTS) {
    it(`rejects AI output containing "${label}"`, async () => {
      setProvider(makeMockProvider(text));

      const frames = await collectFrames(
        { capability: "PATIENT_SNAPSHOT" },
        `Bearer ${FIXTURE_TOKEN}`,
      );
      expect(frames.some((f) => f.type === "error")).toBe(true);
      expect(frames.find((f) => f.type === "done")).toBeUndefined();
    });
  }

  it("allows AI output that refers to documented facts without prescribing", async () => {
    const SAFE = "Documented: Timolol 0.5% eye drops prescribed at previous visit.";
    setProvider(makeMockProvider(SAFE));

    const frames = await collectFrames({ capability: "PATIENT_SNAPSHOT" }, `Bearer ${FIXTURE_TOKEN}`);
    expect(frames.find((f) => f.type === "done")).toBeDefined();
    expect(frames.find((f) => f.type === "error")).toBeUndefined();
  });
});

// ── PII filtering ──────────────────────────────────────────────────────────────

describe("PII filtering in capability pipeline", () => {
  it("context sent to AI does not contain the patient name", async () => {
    const promptsSent: { systemPrompt: string; userMessage: string }[] = [];

    const capturingProvider: AIProvider = {
      id: "capturing",
      model: "mock",
      isConfigured: () => true,
      async complete(req: AiRequest): Promise<AiResult> {
        promptsSent.push({ systemPrompt: req.systemPrompt, userMessage: req.messages[0].content });
        return { text: SAFE_SNAPSHOT, model: "mock", provider: "capturing", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
      },
      async *stream(req: AiRequest): AsyncIterable<AiStreamEvent> {
        promptsSent.push({ systemPrompt: req.systemPrompt, userMessage: req.messages[0].content });
        yield { type: "text", text: SAFE_SNAPSHOT };
        yield { type: "done", model: "mock", provider: "capturing", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
      },
    };

    setProvider(capturingProvider);
    await collectFrames({ capability: "PATIENT_SNAPSHOT" }, `Bearer ${FIXTURE_TOKEN}`);

    expect(promptsSent.length).toBeGreaterThan(0);
    const userMessage = promptsSent[0].userMessage;

    // Patient name from fixture is "Testpatient Alpha" — must not appear in prompt
    expect(userMessage).not.toContain("Testpatient Alpha");
    // UDID must not appear
    expect(userMessage).not.toContain("TEST-UDID-ALPHA-001");
  });
});
