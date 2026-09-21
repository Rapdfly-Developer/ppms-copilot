// resolveOnDemandToken — pure fallback logic for which plugin token an
// on-demand capability trigger's AI request should use. Extracted so this is
// unit-testable without a DOM (this repo's vitest config uses environment:
// "node" — no React renderer available to exercise CopilotApp.tsx directly).
//
// Regression coverage for the fresh-token fix: PPMS_REQUEST_EXAM_GUIDANCE now
// optionally carries a fresh plugin token PPMS Core mints immediately before
// sending the trigger, since the original PPMS_INIT session token has a hard
// 10-minute expiry that an on-demand trigger can easily arrive after.

import { describe, it, expect } from "vitest";
import { resolveOnDemandToken } from "@/lib/on-demand-token";

describe("resolveOnDemandToken", () => {
  it("uses the fresh request token when one is provided", () => {
    const resolved = resolveOnDemandToken("fresh-token-abc", "original-session-token");
    expect(resolved).toBe("fresh-token-abc");
  });

  it("falls back to the session token when no request token is provided", () => {
    const resolved = resolveOnDemandToken(undefined, "original-session-token");
    expect(resolved).toBe("original-session-token");
  });
});
