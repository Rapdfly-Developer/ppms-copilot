import { describe, it, expect } from "vitest";
import { parseNdjsonLine, parseNdjsonStream } from "@/lib/ndjson";
import type { ClientNdjsonFrame } from "@/types/client";

// ── parseNdjsonLine ───────────────────────────────────────────────────────────

describe("parseNdjsonLine", () => {
  describe("text frames", () => {
    it("parses a valid text frame", () => {
      const frame = parseNdjsonLine('{"type":"text","text":"Hello world"}');
      expect(frame).toEqual({ type: "text", text: "Hello world" });
    });

    it("parses a text frame with unicode content", () => {
      const frame = parseNdjsonLine('{"type":"text","text":"Patient: 52歳 男性"}');
      expect(frame).toEqual({ type: "text", text: "Patient: 52歳 男性" });
    });

    it("rejects a text frame with no text field", () => {
      expect(parseNdjsonLine('{"type":"text"}')).toBeNull();
    });

    it("rejects a text frame where text is not a string", () => {
      expect(parseNdjsonLine('{"type":"text","text":42}')).toBeNull();
    });
  });

  describe("warning frames", () => {
    it("parses a warning frame with an array of warnings", () => {
      const frame = parseNdjsonLine(
        '{"type":"warning","warnings":["May require attention","Check documented values"]}',
      );
      expect(frame).toEqual({
        type: "warning",
        warnings: ["May require attention", "Check documented values"],
      });
    });

    it("filters non-string values from the warnings array", () => {
      const frame = parseNdjsonLine(
        '{"type":"warning","warnings":["valid",42,null,"also valid"]}',
      );
      expect(frame).toEqual({
        type: "warning",
        warnings: ["valid", "also valid"],
      });
    });

    it("rejects a warning frame where warnings is not an array", () => {
      expect(
        parseNdjsonLine('{"type":"warning","warnings":"single string"}'),
      ).toBeNull();
    });
  });

  describe("done frames", () => {
    it("parses a done frame with meta", () => {
      const frame = parseNdjsonLine(
        '{"type":"done","meta":{"capability":"PATIENT_SNAPSHOT","producesDraft":false}}',
      );
      expect(frame).toMatchObject({
        type: "done",
        meta: { capability: "PATIENT_SNAPSHOT", producesDraft: false },
      });
    });

    it("parses a done frame with draft meta", () => {
      const frame = parseNdjsonLine(
        '{"type":"done","meta":{"capability":"NOTE_ASSISTANCE","producesDraft":true,"draftType":"consultation_note"}}',
      );
      expect(frame).toMatchObject({
        type: "done",
        meta: { producesDraft: true, draftType: "consultation_note" },
      });
    });

    it("rejects a done frame with no meta", () => {
      expect(parseNdjsonLine('{"type":"done"}')).toBeNull();
    });

    it("rejects a done frame where meta is not an object", () => {
      expect(parseNdjsonLine('{"type":"done","meta":"string"}')).toBeNull();
    });
  });

  describe("error frames", () => {
    it("parses an error frame with discard:true", () => {
      const frame = parseNdjsonLine(
        '{"type":"error","code":"TOKEN_EXPIRED","message":"Session expired. Please reopen from PPMS.","discard":true}',
      );
      expect(frame).toEqual({
        type: "error",
        code: "TOKEN_EXPIRED",
        message: "Session expired. Please reopen from PPMS.",
        discard: true,
      });
    });

    it("sets discard:false when the field is absent", () => {
      const frame = parseNdjsonLine(
        '{"type":"error","code":"AI_UNAVAILABLE","message":"AI service unavailable."}',
      );
      expect(frame).toMatchObject({ type: "error", discard: false });
    });

    it("rejects an error frame missing code", () => {
      expect(
        parseNdjsonLine('{"type":"error","message":"oops"}'),
      ).toBeNull();
    });

    it("rejects an error frame missing message", () => {
      expect(parseNdjsonLine('{"type":"error","code":"ERR"}')).toBeNull();
    });
  });

  describe("malformed / unknown input", () => {
    it("returns null for an empty string", () => {
      expect(parseNdjsonLine("")).toBeNull();
    });

    it("returns null for a whitespace-only string", () => {
      expect(parseNdjsonLine("   \n")).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parseNdjsonLine("{bad json}")).toBeNull();
    });

    it("returns null for a JSON number", () => {
      expect(parseNdjsonLine("42")).toBeNull();
    });

    it("returns null for a JSON string", () => {
      expect(parseNdjsonLine('"hello"')).toBeNull();
    });

    it("returns null for a JSON array", () => {
      expect(parseNdjsonLine('["text","hello"]')).toBeNull();
    });

    it("returns null for an object with an unknown type", () => {
      expect(
        parseNdjsonLine('{"type":"UNKNOWN_FRAME","data":"value"}'),
      ).toBeNull();
    });

    it("returns null for an object with no type field", () => {
      expect(parseNdjsonLine('{"text":"hello"}')).toBeNull();
    });

    it("returns null for an object where type is a number", () => {
      expect(parseNdjsonLine('{"type":1,"text":"hello"}')).toBeNull();
    });
  });
});

// ── parseNdjsonStream ─────────────────────────────────────────────────────────

async function collect(chunks: string[]): Promise<ClientNdjsonFrame[]> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  const frames: ClientNdjsonFrame[] = [];
  for await (const frame of parseNdjsonStream(stream)) {
    frames.push(frame);
  }
  return frames;
}

describe("parseNdjsonStream", () => {
  it("parses a complete single-chunk NDJSON stream", async () => {
    const frames = await collect([
      '{"type":"text","text":"Diagnosis: glaucoma"}\n' +
        '{"type":"done","meta":{"capability":"PATIENT_SNAPSHOT","producesDraft":false}}\n',
    ]);
    expect(frames).toHaveLength(2);
    expect(frames[0].type).toBe("text");
    expect(frames[1].type).toBe("done");
  });

  it("reassembles a frame split across two chunks", async () => {
    const frames = await collect([
      '{"type":"text","te',
      'xt":"hello"}\n',
      '{"type":"done","meta":{"producesDraft":false}}\n',
    ]);
    expect(frames[0]).toEqual({ type: "text", text: "hello" });
  });

  it("handles multiple text frames streamed one char at a time", async () => {
    const line = '{"type":"text","text":"A"}\n';
    const chunks = line.split("").concat(['{"type":"done","meta":{"producesDraft":false}}\n']);
    const frames = await collect(chunks);
    const textFrames = frames.filter((f) => f.type === "text");
    expect(textFrames).toHaveLength(1);
    if (textFrames[0].type === "text") {
      expect(textFrames[0].text).toBe("A");
    }
  });

  it("skips empty lines in the stream", async () => {
    const frames = await collect([
      '\n\n{"type":"text","text":"content"}\n\n',
      '{"type":"done","meta":{"producesDraft":false}}\n',
    ]);
    expect(frames).toHaveLength(2);
  });

  it("skips malformed JSON lines without halting the stream", async () => {
    const frames = await collect([
      '{"type":"text","text":"before"}\n',
      'not-json\n',
      '{"type":"text","text":"after"}\n',
      '{"type":"done","meta":{"producesDraft":false}}\n',
    ]);
    const texts = frames.filter((f) => f.type === "text").map((f) => (f as {type:"text";text:string}).text);
    expect(texts).toEqual(["before", "after"]);
  });

  it("handles a stream with warnings between text frames", async () => {
    const frames = await collect([
      '{"type":"text","text":"Summary"}\n',
      '{"type":"warning","warnings":["Consider reviewing documented values"]}\n',
      '{"type":"done","meta":{"producesDraft":false}}\n',
    ]);
    expect(frames[0]).toMatchObject({ type: "text" });
    expect(frames[1]).toMatchObject({ type: "warning", warnings: ["Consider reviewing documented values"] });
    expect(frames[2]).toMatchObject({ type: "done" });
  });

  it("handles a stream ending with an error frame", async () => {
    const frames = await collect([
      '{"type":"text","text":"partial"}\n',
      '{"type":"error","code":"AI_UNAVAILABLE","message":"AI unavailable.","discard":true}\n',
    ]);
    expect(frames[frames.length - 1]).toMatchObject({ type: "error", code: "AI_UNAVAILABLE", discard: true });
  });

  it("handles a stream with no trailing newline after the last frame", async () => {
    const frames = await collect([
      '{"type":"text","text":"content"}\n',
      '{"type":"done","meta":{"producesDraft":false}}', // no trailing newline
    ]);
    expect(frames[frames.length - 1].type).toBe("done");
  });

  it("processes an empty stream without errors", async () => {
    const frames = await collect([]);
    expect(frames).toHaveLength(0);
  });
});
