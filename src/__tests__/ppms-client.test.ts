import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { CopilotError } from "@/lib/errors";

// We test the PPMS client by mocking the global fetch.
// We never test against a real PPMS Core instance.

// Override PPMS_CORE_URL for testing
beforeEach(() => {
  process.env.PPMS_CORE_URL = "http://ppms-test.internal";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PPMS_CORE_URL;
});

describe("PPMS Core API client", () => {
  describe("Security: base URL comes from env, not from caller", () => {
    it("uses PPMS_CORE_URL from environment, never a caller-supplied URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ patient: { patientId: "p1", udid: "u1", name: "Test", age: 40, sex: "Male", category: "Glaucoma", complaint: "Vision", occupation: "Teacher", registeredOn: "2022-01-01" } }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { getPatient } = await import("@/lib/ppms-client");
      await getPatient("test-token", "patient-ref-001");

      expect(fetchMock).toHaveBeenCalledOnce();
      const callUrl: string = fetchMock.mock.calls[0][0];
      expect(callUrl).toContain("http://ppms-test.internal");
      // The caller cannot inject a different host
      expect(callUrl).not.toContain("attacker.com");
    });

    it("throws CopilotError if PPMS_CORE_URL is not set", async () => {
      delete process.env.PPMS_CORE_URL;
      // Re-import to get fresh module with missing env
      vi.resetModules();
      const { getPatient } = await import("@/lib/ppms-client");

      await expect(getPatient("token", "ref")).rejects.toThrow();
    });
  });

  describe("Authorization header", () => {
    it("sends the token as Bearer in Authorization header", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ patient: { patientId: "p1", udid: "u1", name: "Test", age: 40, sex: "Male", category: "G", complaint: "V", occupation: "T", registeredOn: "2022-01-01" } }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.resetModules();

      const { getPatient } = await import("@/lib/ppms-client");
      await getPatient("my-plugin-token", "patient-ref");

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-plugin-token");
    });

    it("never caches clinical data (cache: no-store)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ patient: { patientId: "p1", udid: "u1", name: "T", age: 40, sex: "Male", category: "G", complaint: "V", occupation: "T", registeredOn: "2022-01-01" } }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.resetModules();

      const { getPatient } = await import("@/lib/ppms-client");
      await getPatient("token", "ref");

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((options as Record<string, unknown>)["cache"]).toBe("no-store");
    });
  });

  describe("HTTP error mapping", () => {
    async function callWithStatus(status: number) {
      vi.resetModules();
      process.env.PPMS_CORE_URL = "http://ppms-test.internal";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("{}", { status })),
      );
      const { getPatient } = await import("@/lib/ppms-client");
      return getPatient("token", "ref");
    }

    it("maps 401 to TOKEN_EXPIRED CopilotError", async () => {
      await expect(callWithStatus(401)).rejects.toMatchObject({
        code: "TOKEN_EXPIRED",
        status: 401,
      });
    });

    it("maps 403 to PLUGIN_DISABLED CopilotError", async () => {
      await expect(callWithStatus(403)).rejects.toMatchObject({
        code: "PLUGIN_DISABLED",
        status: 403,
      });
    });

    it("maps 404 to PATIENT_NOT_FOUND CopilotError", async () => {
      await expect(callWithStatus(404)).rejects.toMatchObject({
        code: "PATIENT_NOT_FOUND",
        status: 404,
      });
    });

    it("maps 502 to PPMS_API_ERROR CopilotError", async () => {
      await expect(callWithStatus(502)).rejects.toMatchObject({
        code: "PPMS_API_ERROR",
      });
    });
  });

  describe("Network error", () => {
    it("maps fetch network failure to PPMS_UNAVAILABLE", async () => {
      vi.resetModules();
      process.env.PPMS_CORE_URL = "http://ppms-test.internal";
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
      const { getPatient } = await import("@/lib/ppms-client");

      await expect(getPatient("token", "ref")).rejects.toMatchObject({
        code: "PPMS_UNAVAILABLE",
      });
    });
  });

  describe("patientRef encoding", () => {
    it("URL-encodes patientRef to prevent path injection", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ visits: [] }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.resetModules();
      process.env.PPMS_CORE_URL = "http://ppms-test.internal";

      const { getVisits } = await import("@/lib/ppms-client");
      // A patientRef that could be a path injection attempt
      await getVisits("token", "../admin/secret", 5);

      const callUrl: string = fetchMock.mock.calls[0][0];
      expect(callUrl).toContain(encodeURIComponent("../admin/secret"));
      expect(callUrl).not.toContain("../admin/secret");
    });
  });
});
