import { describe, it, expect } from "vitest";
import { validatePpmsInitMessage } from "@/lib/postmessage-validator";

const EXPECTED_ORIGIN = "https://ppmsai.com";

function makeInitMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "PPMS_INIT",
    version: "1",
    pluginId: "ppms.plugin.ai-clinical-copilot",
    token: "eyJ.test.token",
    patientRef: "patient-ref-001",
    visitId: "visit-001",
    ppmsVersion: "16.2.9",
    ...overrides,
  };
}

describe("validatePpmsInitMessage — origin validation", () => {
  it("accepts a message with the correct origin and valid data", () => {
    const result = validatePpmsInitMessage(
      EXPECTED_ORIGIN,
      makeInitMessage(),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a message from a different origin", () => {
    const result = validatePpmsInitMessage(
      "https://evil.example.com",
      makeInitMessage(),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("origin_mismatch");
  });

  it("rejects a message from a subdomain of the expected origin", () => {
    const result = validatePpmsInitMessage(
      "https://subdomain.ppmsai.com",
      makeInitMessage(),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a message from localhost when origin is production", () => {
    const result = validatePpmsInitMessage(
      "http://localhost:3000",
      makeInitMessage(),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects when expectedOrigin is empty (misconfigured Copilot)", () => {
    const result = validatePpmsInitMessage(EXPECTED_ORIGIN, makeInitMessage(), "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_expected_origin");
  });

  it('never accepts "*" as expectedOrigin', () => {
    const result = validatePpmsInitMessage("*", makeInitMessage(), "*");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("origin_mismatch");
  });

  it("rejects origin mismatch even when data is perfectly valid", () => {
    const result = validatePpmsInitMessage(
      "https://other.ppmsai.com",
      makeInitMessage(),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
  });
});

describe("validatePpmsInitMessage — message structure", () => {
  it("rejects null data", () => {
    const result = validatePpmsInitMessage(EXPECTED_ORIGIN, null, EXPECTED_ORIGIN);
    expect(result.ok).toBe(false);
  });

  it("rejects a string payload", () => {
    const result = validatePpmsInitMessage(EXPECTED_ORIGIN, "PPMS_INIT", EXPECTED_ORIGIN);
    expect(result.ok).toBe(false);
  });

  it("rejects a number payload", () => {
    const result = validatePpmsInitMessage(EXPECTED_ORIGIN, 42, EXPECTED_ORIGIN);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty object", () => {
    const result = validatePpmsInitMessage(EXPECTED_ORIGIN, {}, EXPECTED_ORIGIN);
    expect(result.ok).toBe(false);
  });

  it("rejects wrong message type", () => {
    const result = validatePpmsInitMessage(
      EXPECTED_ORIGIN,
      makeInitMessage({ type: "PLUGIN_READY" }),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_type");
  });

  it("rejects wrong protocol version", () => {
    const result = validatePpmsInitMessage(
      EXPECTED_ORIGIN,
      makeInitMessage({ version: "2" }),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_version");
  });

  it("rejects missing version field", () => {
    const msg = makeInitMessage();
    delete msg.version;
    const result = validatePpmsInitMessage(EXPECTED_ORIGIN, msg, EXPECTED_ORIGIN);
    expect(result.ok).toBe(false);
  });
});

describe("validatePpmsInitMessage — required fields", () => {
  it("rejects missing token", () => {
    const result = validatePpmsInitMessage(
      EXPECTED_ORIGIN,
      makeInitMessage({ token: "" }),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_token");
  });

  it("rejects whitespace-only token", () => {
    const result = validatePpmsInitMessage(
      EXPECTED_ORIGIN,
      makeInitMessage({ token: "   " }),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects missing visitId", () => {
    const result = validatePpmsInitMessage(
      EXPECTED_ORIGIN,
      makeInitMessage({ visitId: "" }),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_visitId");
  });

  it("rejects missing patientRef", () => {
    const result = validatePpmsInitMessage(
      EXPECTED_ORIGIN,
      makeInitMessage({ patientRef: "" }),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_patientRef");
  });

  it("returns the validated message fields on success", () => {
    const result = validatePpmsInitMessage(
      EXPECTED_ORIGIN,
      makeInitMessage({
        token: "eyJ.real-token.sig",
        visitId: "visit-abc",
        patientRef: "patient-xyz",
      }),
      EXPECTED_ORIGIN,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.token).toBe("eyJ.real-token.sig");
      expect(result.message.visitId).toBe("visit-abc");
      expect(result.message.patientRef).toBe("patient-xyz");
    }
  });
});

describe("validatePpmsInitMessage — token expiry handling contract", () => {
  it("validates the message structure regardless of token expiry (expiry is checked server-side)", () => {
    // The validator only checks the message shape.
    // Token expiry is enforced by the PPMS Core API on every request.
    // Copilot detects expiry when the stream returns TOKEN_EXPIRED error code.
    const expiredTokenPayload = btoa(JSON.stringify({ exp: 1000 })); // Unix 1970
    const fakeExpiredToken = `header.${expiredTokenPayload}.sig`;

    const result = validatePpmsInitMessage(
      EXPECTED_ORIGIN,
      makeInitMessage({ token: fakeExpiredToken }),
      EXPECTED_ORIGIN,
    );

    // postMessage validator accepts any non-empty token string.
    // Expiry rejection happens in parseRequest (server side).
    expect(result.ok).toBe(true);
  });
});
