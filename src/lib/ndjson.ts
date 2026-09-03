// NDJSON stream parser — client-safe, no server imports.
//
// The server emits one JSON object per line. The client reads a ReadableStream
// of bytes, reassembles lines across chunk boundaries, and yields typed frames.

import type { ClientNdjsonFrame, DoneMeta } from "@/types/client";

export function parseNdjsonLine(line: string): ClientNdjsonFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!obj || typeof obj !== "object") return null;

  const raw = obj as Record<string, unknown>;
  if (typeof raw.type !== "string") return null;

  switch (raw.type) {
    case "text":
      if (typeof raw.text !== "string") return null;
      return { type: "text", text: raw.text };

    case "warning":
      if (!Array.isArray(raw.warnings)) return null;
      return {
        type: "warning",
        warnings: (raw.warnings as unknown[]).filter(
          (w): w is string => typeof w === "string",
        ),
      };

    case "done":
      if (!raw.meta || typeof raw.meta !== "object") return null;
      return { type: "done", meta: raw.meta as DoneMeta };

    case "error":
      if (typeof raw.code !== "string" || typeof raw.message !== "string") return null;
      return {
        type: "error",
        code: raw.code,
        message: raw.message,
        discard: raw.discard === true,
      };

    default:
      return null;
  }
}

export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ClientNdjsonFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Last element may be an incomplete line — hold it in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const frame = parseNdjsonLine(line);
        if (frame) yield frame;
      }
    }

    // Flush any remaining bytes after the stream closes.
    if (buffer.trim()) {
      const frame = parseNdjsonLine(buffer);
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}
