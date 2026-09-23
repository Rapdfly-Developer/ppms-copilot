// lib/bundle-cache.ts — per-visit sessionStorage cache of the completed
// consolidated bundle, so a page reload's PPMS_INIT reuses it instead of
// re-running the AI call. Storage is injected (vitest runs in "node", with no
// window.sessionStorage).

import { describe, it, expect } from "vitest";
import { readCachedBundle, writeCachedBundle, clearCachedBundle } from "@/lib/bundle-cache";
import type { CopilotData, CopilotGenerateState } from "@/types/client";

class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) { this.items.set(key, value); }
}

const OK = (text: string) => ({ ok: true as const, text, warnings: [] });

function doneState(requestId: string): CopilotGenerateState & { status: "done" } {
  const data: CopilotData = {
    timeline: OK("timeline"),
    attention: OK("attention"),
    draftNote: OK("draftNote"),
    followUp: OK("followUp"),
    differentialDiagnosis: OK("differentialDiagnosis"),
    medications: OK("medications"),
    investigations: OK("investigations"),
    assessmentContext: OK("assessmentContext"),
    suggestedQuestions: OK("suggestedQuestions"),
    planGuidance: OK("planGuidance"),
    investigationGuidance: OK("investigationGuidance"),
    diagnosisComparison: { ok: false, errorCode: "RESPONSE_EMPTY", errorMessage: "empty" },
  };
  return { status: "done", data, meta: { requestId } };
}

describe("bundle cache", () => {
  it("returns a written bundle for the same visit only", () => {
    const storage = new MemoryStorage();
    writeCachedBundle("visit-1", doneState("req-1"), storage);
    expect(readCachedBundle("visit-1", storage)).toEqual(doneState("req-1"));
    expect(readCachedBundle("visit-2", storage)).toBeNull();
  });

  it("clears a visit's bundle so Regenerate fetches fresh", () => {
    const storage = new MemoryStorage();
    writeCachedBundle("visit-1", doneState("req-1"), storage);
    clearCachedBundle("visit-1", storage);
    expect(readCachedBundle("visit-1", storage)).toBeNull();
  });

  it("discards malformed or old-shape entries", () => {
    const storage = new MemoryStorage();
    storage.setItem("ppms-copilot:bundle:v1:visit-1", "{not json");
    expect(readCachedBundle("visit-1", storage)).toBeNull();
    const { timeline: _dropped, ...partial } = doneState("req-1").data;
    storage.setItem("ppms-copilot:bundle:v1:visit-1", JSON.stringify({ status: "done", data: partial, meta: {} }));
    expect(readCachedBundle("visit-1", storage)).toBeNull();
    expect(storage.getItem("ppms-copilot:bundle:v1:visit-1")).toBeNull();
  });

  it("never throws when storage is unavailable or refuses writes", () => {
    const throwing = new MemoryStorage();
    throwing.getItem = () => { throw new Error("SecurityError"); };
    throwing.setItem = () => { throw new Error("QuotaExceededError"); };
    throwing.removeItem = () => { throw new Error("SecurityError"); };
    expect(() => writeCachedBundle("visit-1", doneState("req-1"), throwing)).not.toThrow();
    expect(readCachedBundle("visit-1", throwing)).toBeNull();
    expect(() => clearCachedBundle("visit-1", throwing)).not.toThrow();
    expect(readCachedBundle("visit-1", null)).toBeNull();
  });

  it("does not store the session token", () => {
    const storage = new MemoryStorage();
    writeCachedBundle("visit-1", doneState("req-1"), storage);
    expect(storage.getItem("ppms-copilot:bundle:v1:visit-1")).not.toMatch(/token/i);
  });
});
