// POST /api/copilot/stream
//
// Accepts a plugin token (Bearer header) + capability (body), fetches patient
// context from PPMS Core, calls the AI provider, validates the response, and
// returns an NDJSON stream of frames.
//
// Runtime: Node.js — the openai SDK (used for Groq) relies on Node.js streams.
// Do NOT change to "edge".

export const runtime = "nodejs";

import { streamCopilotResponse } from "@/service/copilot";
import { assertServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

// Validate required env vars at module load time so misconfigurations are
// caught on the first cold start rather than mid-request.
try {
  assertServerEnv();
} catch (err) {
  logger.error("env_validation_failed", { code: (err as Error).message });
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON", 400);
  }

  const authHeader = req.headers.get("authorization");
  const encoder = new TextEncoder();

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of streamCopilotResponse(body, authHeader)) {
          controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
        }
      } catch (err) {
        logger.error("stream_route_exception", {
          code: (err as Error).message?.slice(0, 60),
        });
        const fallback = JSON.stringify({
          type: "error",
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred. Please try again.",
          discard: true,
        });
        controller.enqueue(encoder.encode(fallback + "\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
    },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ type: "error", code, message, discard: true }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
