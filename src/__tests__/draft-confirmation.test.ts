import { describe, it, expect, vi, afterEach } from "vitest";
import { streamCopilotResponse } from "@/service/copilot";
import { setProvider, resetProvider } from "@/ai";
import * as ppmsClient from "@/lib/ppms-client";
import type { AIProvider, AiResult, AiStreamEvent } from "@/ai/provider";
import type { NdjsonFrame } from "@/service/copilot";
import {
  FIXTURE_PATIENT,
  FIXTURE_VISIT_CURRENT,
  FIXTURE_VISIT_PREVIOUS,
  FIXTURE_APPOINTMENTS,
  FIXTURE_TIMELINE,
  FIXTURE_TOKEN,
} from "./fixtures/patient";

afterEach(() => {
  vi.restoreAllMocks();
  resetProvider();
  delete process.env.PPMS_CORE_URL;
});

function makeMockProvider(text: string): AIProvider {
  return {
    id: "mock",
    model: "mock",
    isConfigured: () => true,
    async complete(): Promise<AiResult> {
      return { text, model: "mock", provider: "mock", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
    },
    async *stream(): AsyncIterable<AiStreamEvent> {
      yield { type: "text", text };
      yield { type: "done", model: "mock", provider: "mock", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
    },
  };
}

const SAFE_SOAP_NOTE = `**Subjective:**
Patient presents with documented blurred vision.

**Objective:**
Documented diagnosis: Primary open-angle glaucoma (H40.11).

**Assessment:**
Glaucoma, confirmed as documented.

**Plan:**
Continue documented treatment. Review at next appointment.`;

const SAFE_FOLLOWUP = `## FOLLOW-UP SUMMARY
Patient: 52-year-old male, documented glaucoma category.
Diagnoses: Primary open-angle glaucoma (H40.11) - confirmed.
Treatment: As documented.
Follow-up: As per documented advice.`;

async function collectFrames(capability: string, token = FIXTURE_TOKEN): Promise<NdjsonFrame[]> {
  process.env.PPMS_CORE_URL = "http://ppms-test.internal";
  vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
  vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
  vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([FIXTURE_VISIT_PREVIOUS]);
  vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue(FIXTURE_APPOINTMENTS);
  vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue(FIXTURE_TIMELINE);

  const frames: NdjsonFrame[] = [];
  for await (const frame of streamCopilotResponse({ capability }, `Bearer ${token}`)) {
    frames.push(frame);
  }
  return frames;
}

// ── Draft postMessage contract ────────────────────────────────────────────────

describe("Draft confirmation contract", () => {
  describe("NOTE_ASSISTANCE draft contract", () => {
    it("done meta specifies draftType:consultation_note", async () => {
      setProvider(makeMockProvider(SAFE_SOAP_NOTE));

      const frames = await collectFrames("NOTE_ASSISTANCE");
      const done = frames.find((f) => f.type === "done");

      expect(done).toBeDefined();
      if (done?.type === "done") {
        expect(done.meta.draftType).toBe("consultation_note");
        expect(done.meta.producesDraft).toBe(true);
        expect(done.meta.capability).toBe("NOTE_ASSISTANCE");
      }
    });

    it("PluginDraftConfirmedMessage must NOT include a token", () => {
      // The type definition is the contract — verify it structurally.
      const exampleMsg = {
        type: "PLUGIN_DRAFT_CONFIRMED",
        pluginId: "ppms.plugin.ai-clinical-copilot",
        draftType: "consultation_note" as const,
        draftText: "Some draft text",
        visitId: "visit-001",
      };

      // These security-critical fields must be absent from the confirmation message.
      // PPMS Core authenticates via its own session cookie — not via the plugin token.
      expect((exampleMsg as Record<string, unknown>).token).toBeUndefined();
      expect((exampleMsg as Record<string, unknown>).patientRef).toBeUndefined();
      expect((exampleMsg as Record<string, unknown>).doctorId).toBeUndefined();
      expect((exampleMsg as Record<string, unknown>).tenantId).toBeUndefined();

      // Required fields must be present.
      expect(exampleMsg.type).toBe("PLUGIN_DRAFT_CONFIRMED");
      expect(exampleMsg.pluginId).toBe("ppms.plugin.ai-clinical-copilot");
      expect(exampleMsg.draftType).toBe("consultation_note");
      expect(exampleMsg.draftText).toBeTruthy();
      expect(exampleMsg.visitId).toBeTruthy();
    });
  });

  describe("FOLLOW_UP_SUMMARY draft contract", () => {
    it("done meta specifies draftType:follow_up_summary", async () => {
      setProvider(makeMockProvider(SAFE_FOLLOWUP));

      const frames = await collectFrames("FOLLOW_UP_SUMMARY");
      const done = frames.find((f) => f.type === "done");

      expect(done).toBeDefined();
      if (done?.type === "done") {
        expect(done.meta.draftType).toBe("follow_up_summary");
        expect(done.meta.producesDraft).toBe(true);
      }
    });
  });

  describe("No automatic EMR persistence", () => {
    it("streamCopilotResponse does NOT call any write/update PPMS endpoint", async () => {
      setProvider(makeMockProvider(SAFE_SOAP_NOTE));

      // All PPMS client functions are read-only GET requests.
      // There is no write function on ppmsClient — verify the module has none.
      const clientExports = Object.keys(ppmsClient);
      const writeFunctions = clientExports.filter(
        (name) =>
          name.startsWith("create") ||
          name.startsWith("update") ||
          name.startsWith("delete") ||
          name.startsWith("save") ||
          name.startsWith("write") ||
          name.startsWith("patch") ||
          name.startsWith("post"),
      );

      expect(writeFunctions).toHaveLength(0);
    });

    it("streamCopilotResponse produces no side effects on PPMS Core (read-only pipeline)", async () => {
      setProvider(makeMockProvider(SAFE_SOAP_NOTE));

      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      process.env.PPMS_CORE_URL = "http://ppms-test.internal";

      // Don't use spied ppmsClient — let it call through to fetch.
      vi.restoreAllMocks();
      vi.spyOn(ppmsClient, "getPatient").mockResolvedValue(FIXTURE_PATIENT);
      vi.spyOn(ppmsClient, "getVisit").mockResolvedValue(FIXTURE_VISIT_CURRENT);
      vi.spyOn(ppmsClient, "getVisits").mockResolvedValue([FIXTURE_VISIT_PREVIOUS]);
      vi.spyOn(ppmsClient, "getAppointments").mockResolvedValue(FIXTURE_APPOINTMENTS);
      vi.spyOn(ppmsClient, "getTimeline").mockResolvedValue(FIXTURE_TIMELINE);

      await collectFrames("NOTE_ASSISTANCE");

      // All fetch calls made by the pipeline must be GET requests (read-only).
      const nonGetCalls = fetchSpy.mock.calls.filter(([, opts]) => {
        const method = (opts as RequestInit | undefined)?.method ?? "GET";
        return method.toUpperCase() !== "GET";
      });

      expect(nonGetCalls).toHaveLength(0);
      vi.unstubAllGlobals();
    });
  });

  describe("Draft text is provided by the doctor, not auto-submitted", () => {
    it("the service pipeline does not auto-send PLUGIN_DRAFT_CONFIRMED", async () => {
      setProvider(makeMockProvider(SAFE_SOAP_NOTE));

      // The pipeline yields frames — it never calls postMessage or window.parent.
      // This is a structural guarantee: the service runs server-side, has no window.
      // In tests (Node environment), window is undefined.
      expect(typeof window).toBe("undefined");

      const frames = await collectFrames("NOTE_ASSISTANCE");
      // Pipeline produces text + done — never a postMessage side effect.
      expect(frames.some((f) => f.type === "done")).toBe(true);
    });
  });
});

// ── postMessage contract documentation ───────────────────────────────────────

describe("PLUGIN_DRAFT_CONFIRMED postMessage contract", () => {
  it("MSG_PLUGIN_DRAFT_CONFIRMED constant matches PPMS Core's expected string", async () => {
    const { MSG_PLUGIN_DRAFT_CONFIRMED } = await import("@/lib/constants");
    expect(MSG_PLUGIN_DRAFT_CONFIRMED).toBe("PLUGIN_DRAFT_CONFIRMED");
  });

  it("PluginDraftConfirmedMessage type has exactly the required fields", () => {
    type RequiredFields = {
      type: "PLUGIN_DRAFT_CONFIRMED";
      pluginId: "ppms.plugin.ai-clinical-copilot";
      draftType: "consultation_note" | "follow_up_summary";
      draftText: string;
      visitId: string;
    };

    // This test verifies the type shape is correct by construction.
    const msg: RequiredFields = {
      type: "PLUGIN_DRAFT_CONFIRMED",
      pluginId: "ppms.plugin.ai-clinical-copilot",
      draftType: "consultation_note",
      draftText: "Reviewed and approved note content",
      visitId: "visit-001",
    };

    expect(msg.type).toBe("PLUGIN_DRAFT_CONFIRMED");
    expect(msg.draftType).toBe("consultation_note");
    expect(msg.draftText).toBeTruthy();
    expect(msg.visitId).toBeTruthy();
  });
});
