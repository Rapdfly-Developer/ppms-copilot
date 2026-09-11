// POST /api/copilot/generate
//
// Consolidated Copilot endpoint: one authenticated request generates all six
// MVP sections (snapshot, previousVisits, timeline, attention, draftNote,
// followUp) in a single AI call and returns a structured JSON response.
//
// Architecture benefit over /api/copilot/stream:
//   - 1 AI call instead of up to 6
//   - Patient context built once, not per tab
//   - ~83% fewer Vercel Function Invocations per visit open
//   - ~83% fewer Groq API calls (eliminates the primary rate-limit cause)
//
// Security:
//   - patientRef and visitId come from the decoded plugin token ONLY.
//   - Every PPMS Core API call uses the token — PPMS Core enforces tenant,
//     org, role, patient scope on each call.
//   - Response is private and non-cacheable (no-store, private).
//
// Runtime: Node.js — the openai SDK used for Groq requires Node.js streams.

export const runtime = "nodejs";

import { generateCopilot } from "@/service/copilot-generate";
import { assertServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

try {
  assertServerEnv();
} catch (err) {
  logger.error("env_validation_failed", { code: (err as Error).message });
}

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");

  const result = await generateCopilot(authHeader);

  if (!result.ok) {
    return new Response(
      JSON.stringify({ errorCode: result.errorCode, errorMessage: result.errorMessage }),
      {
        status: result.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate, private",
        },
      },
    );
  }

  return new Response(
    JSON.stringify({ result: { ...result.data, meta: result.meta } }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
      },
    },
  );
}
