import { describe, it, expect, vi, afterEach } from "vitest";
import { parseRequest } from "@/schemas/request";
import { makeFixtureToken, FIXTURE_TOKEN } from "./fixtures/patient";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Security boundaries", () => {
  describe("PPMS_CORE_URL cannot be overridden from request", () => {
    it("the request body has no field that could change the PPMS target URL", () => {
      const result = parseRequest(
        {
          capability: "PATIENT_SNAPSHOT",
          ppmsBaseUrl: "https://attacker.com",   // attempt #1
          ppmsUrl: "https://evil.example.com",   // attempt #2
          baseUrl: "https://malicious.internal", // attempt #3
        },
        `Bearer ${FIXTURE_TOKEN}`,
      );

      // Request is accepted (capabilities are valid) but none of these fields
      // are on the CopilotRequest type — they are completely ignored
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.data as Record<string, unknown>).ppmsBaseUrl).toBeUndefined();
        expect((result.data as Record<string, unknown>).ppmsUrl).toBeUndefined();
        expect((result.data as Record<string, unknown>).baseUrl).toBeUndefined();
      }
    });
  });

  describe("Token must come from Authorization header — never from body", () => {
    it("rejects a request where the token is only in the body", () => {
      const result = parseRequest(
        {
          capability: "PATIENT_SNAPSHOT",
          token: FIXTURE_TOKEN, // attempt to supply token in body
        },
        null, // no Authorization header
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("TOKEN_MISSING");
    });
  });

  describe("Capability injection via body cannot escalate permissions", () => {
    it("does not allow injecting a non-capability string that looks like a system command", () => {
      const maliciousCapabilities = [
        "ADMIN",
        "ROOT",
        "__PROTO__",
        "constructor",
        "BYPASS_AUTH",
        "",
        null,
        undefined,
        123,
        { $ne: null },
      ];

      for (const cap of maliciousCapabilities) {
        const result = parseRequest({ capability: cap }, `Bearer ${FIXTURE_TOKEN}`);
        expect(result.ok).toBe(false);
      }
    });
  });

  describe("Token payload tampering detection", () => {
    it("rejects a token with a missing patientRef in payload", () => {
      const token = makeFixtureToken({ patientRef: "" } as Parameters<typeof makeFixtureToken>[0]);
      const result = parseRequest({ capability: "PATIENT_SNAPSHOT" }, `Bearer ${token}`);
      expect(result.ok).toBe(false);
    });

    it("rejects a token with a missing visitId in payload", () => {
      const token = makeFixtureToken({ visitId: "" } as Parameters<typeof makeFixtureToken>[0]);
      const result = parseRequest({ capability: "PATIENT_SNAPSHOT" }, `Bearer ${token}`);
      expect(result.ok).toBe(false);
    });
  });

  describe("ANTHROPIC_API_KEY is server-side only", () => {
    it("getAnthropicApiKey() reads from process.env (server), not from a browser-visible source", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-server-only");
      const { getAnthropicApiKey } = await import("@/lib/env");
      // The function reads process.env, which is never the browser's window object
      expect(getAnthropicApiKey()).toBe("sk-ant-server-only");
    });

    it("env.ts does not export any NEXT_PUBLIC_ variable for the API key", async () => {
      // Verify by checking the module exports — none should expose the key to browser
      const envModule = await import("@/lib/env");
      const exportedKeys = Object.keys(envModule);
      // None of the exported functions should expose the raw key value publicly
      expect(exportedKeys).not.toContain("ANTHROPIC_API_KEY");
      expect(exportedKeys).toContain("getAnthropicApiKey"); // only accessible server-side
    });
  });

  describe("Request body fields are typed — no extra fields leak into pipeline", () => {
    it("CopilotRequest from parseRequest only contains expected fields", () => {
      const result = parseRequest(
        {
          capability: "QUESTION",
          question: "What is the diagnosis?",
          // Extra fields that should be stripped:
          isAdmin: true,
          __bypass: true,
          extra: "data",
        },
        `Bearer ${FIXTURE_TOKEN}`,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const keys = Object.keys(result.data);
        expect(keys).toContain("token");
        expect(keys).toContain("capability");
        expect(keys).toContain("patientRef");
        expect(keys).toContain("visitId");
        expect(keys).toContain("question");
        expect(keys).not.toContain("isAdmin");
        expect(keys).not.toContain("__bypass");
        expect(keys).not.toContain("extra");
      }
    });
  });

  describe("USER_MESSAGES — no vendor text forwarded", () => {
    it("USER_MESSAGES contains a fixed string for every error code", async () => {
      const { USER_MESSAGES, ERROR_CODES } = await import("@/lib/errors");
      for (const code of Object.values(ERROR_CODES)) {
        expect(USER_MESSAGES[code]).toBeDefined();
        expect(typeof USER_MESSAGES[code]).toBe("string");
        expect(USER_MESSAGES[code].length).toBeGreaterThan(0);
      }
    });

    it("no USER_MESSAGE contains technical vendor details", async () => {
      const { USER_MESSAGES } = await import("@/lib/errors");
      for (const msg of Object.values(USER_MESSAGES)) {
        // Should not contain SDK-specific phrases that could leak internal details
        expect(msg).not.toMatch(/anthropic/i);
        expect(msg).not.toMatch(/prisma/i);
        expect(msg).not.toMatch(/database/i);
        expect(msg).not.toMatch(/sql/i);
        expect(msg).not.toMatch(/stack trace/i);
      }
    });
  });
});
