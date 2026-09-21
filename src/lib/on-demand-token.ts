// Resolves which plugin token an on-demand capability trigger (e.g.
// PPMS_REQUEST_EXAM_GUIDANCE) should use for its AI request.
//
// PPMS Core mints a fresh token (POST /api/v1/plugin-token) immediately
// before sending an on-demand trigger message, since the original PPMS_INIT
// session token has a hard 10-minute server-side expiry
// (MAX_TOKEN_LIFETIME_SECONDS) and a trigger can easily arrive well after
// that if the doctor takes a while to reach this point in the visit. Prefer
// that fresh token whenever the trigger message carried one; fall back to
// the session token only for backward compatibility with a trigger that
// didn't include one (an older PPMS Core build).
//
// Extracted as a pure function — same "testable without a DOM" reasoning as
// lib/differential-update.ts (this repo's vitest config is environment:
// "node", with no React renderer available) — and shared by any future
// on-demand capability, not just EXAM_GUIDANCE.
export function resolveOnDemandToken(requestToken: string | undefined, sessionToken: string): string {
  return requestToken ?? sessionToken;
}
