// Request parsing and validation for the /api/copilot/* routes.
//
// Security invariants enforced here:
//   - patientRef and visitId are extracted from the plugin token ONLY.
//     The request body cannot supply or override them.
//   - capability is validated against the known-good list.
//   - The plugin token is forwarded as-is — we decode (not verify) it here
//     only to extract routing fields. PPMS Core verifies the signature on every
//     /api/v1/* call that uses this token.

import { isValidCapability, type Capability } from "@/capabilities";

export type CopilotRequest = {
  token: string;
  capability: Capability;
  patientRef: string;  // from decoded token — not from request body
  visitId: string;     // from decoded token — not from request body
  question?: string;
};

export type ParseResult =
  | { ok: true; data: CopilotRequest }
  | { ok: false; code: string; message: string; status: number };

// Token payload fields we need for routing.
// We decode WITHOUT verifying — PPMS Core verifies the HMAC on every API call.
type TokenRouting = {
  patientRef: string;
  visitId: string;
  exp: number;
};

function decodeTokenRouting(token: string): TokenRouting | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    const { patientRef, visitId, exp } = payload;

    if (
      typeof patientRef !== "string" || !patientRef ||
      typeof visitId !== "string" || !visitId ||
      typeof exp !== "number"
    ) {
      return null;
    }

    // Belt-and-suspenders expiry check (PPMS Core also checks on every API call)
    if (Math.floor(Date.now() / 1000) > exp) {
      return null;
    }

    return { patientRef, visitId, exp };
  } catch {
    return null;
  }
}

export function parseRequest(
  body: unknown,
  authorizationHeader: string | null,
): ParseResult {
  // 1. Token must come from Authorization header — never from the request body
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      code: "TOKEN_MISSING",
      message: "Authorization: Bearer <token> header required",
      status: 401,
    };
  }

  const token = authorizationHeader.slice(7).trim();
  if (!token) {
    return { ok: false, code: "TOKEN_MISSING", message: "Token is empty", status: 401 };
  }

  // 2. Decode token to extract routing fields (patientRef, visitId)
  const routing = decodeTokenRouting(token);
  if (!routing) {
    return {
      ok: false,
      code: "TOKEN_INVALID",
      message: "Token is malformed or expired",
      status: 401,
    };
  }

  // 3. Validate request body
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Request body must be a JSON object",
      status: 400,
    };
  }

  const { capability, question } = body as Record<string, unknown>;

  if (!isValidCapability(capability)) {
    return {
      ok: false,
      code: "INVALID_CAPABILITY",
      message: `Invalid capability. Valid values: ${["PATIENT_SNAPSHOT","PREVIOUS_VISIT_SUMMARY","HISTORY_SUMMARY","TIMELINE_SUMMARY","IMPORTANT_CHANGES","NOTE_ASSISTANCE","FOLLOW_UP_SUMMARY","QUESTION"].join(", ")}`,
      status: 400,
    };
  }

  if (question !== undefined) {
    if (typeof question !== "string") {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: "question must be a string",
        status: 400,
      };
    }
    if (question.length > 2000) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: "question must be under 2000 characters",
        status: 400,
      };
    }
  }

  return {
    ok: true,
    data: {
      token,
      capability: capability as Capability,
      // These come from the token — the body cannot override them
      patientRef: routing.patientRef,
      visitId: routing.visitId,
      question: typeof question === "string" && question.trim() ? question.trim() : undefined,
    },
  };
}
