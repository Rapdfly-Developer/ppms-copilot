// Pure postMessage validation logic — no React, no server imports.
// Extracted so it can be unit-tested independently of the React hook.

import type { PpmsInitMessage } from "@/postmessage/types";
import { MSG_PPMS_INIT } from "@/lib/constants";

export type ValidatePpmsInitResult =
  | { ok: true; message: PpmsInitMessage }
  | { ok: false; reason: string };

export function validatePpmsInitMessage(
  eventOrigin: string,
  eventData: unknown,
  expectedOrigin: string,
): ValidatePpmsInitResult {
  // No configured origin — reject everything.
  if (!expectedOrigin) {
    return { ok: false, reason: "no_expected_origin" };
  }

  // Strict origin check — first security boundary.
  // "*" is never accepted as expectedOrigin.
  if (expectedOrigin === "*" || eventOrigin !== expectedOrigin) {
    return { ok: false, reason: "origin_mismatch" };
  }

  if (!eventData || typeof eventData !== "object") {
    return { ok: false, reason: "data_not_object" };
  }

  const data = eventData as Record<string, unknown>;

  if (data.type !== MSG_PPMS_INIT) {
    return { ok: false, reason: "wrong_type" };
  }

  // version "1" is required — allows future protocol upgrades.
  if (data.version !== "1") {
    return { ok: false, reason: "wrong_version" };
  }

  if (typeof data.token !== "string" || !data.token.trim()) {
    return { ok: false, reason: "missing_token" };
  }

  if (typeof data.visitId !== "string" || !data.visitId.trim()) {
    return { ok: false, reason: "missing_visitId" };
  }

  if (typeof data.patientRef !== "string" || !data.patientRef.trim()) {
    return { ok: false, reason: "missing_patientRef" };
  }

  return { ok: true, message: data as unknown as PpmsInitMessage };
}
