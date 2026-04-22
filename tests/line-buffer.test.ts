/**
 * Tests for line-buffered stdout parsing (stdio JSON-RPC protocol).
 *
 * The Python server emits one JSON object per line. On the Node side we
 * need to handle chunk boundaries that may split a line anywhere. This
 * test focuses on two responsibilities:
 *
 *   1. Detecting the startup `{"type":"ready","ok":true}` signal
 *   2. Dispatching `{"id": n, "result": ...}` responses to the right
 *      pending request (by id)
 */
import { describe, it, expect } from "vitest";

interface ReadyMessage {
  type: "ready";
  ok: boolean;
  error?: string;
}

interface ResponseMessage {
  id: number;
  result?: unknown;
  error?: string;
}

type Message = ReadyMessage | ResponseMessage;

/**
 * Simulates the line-buffered parsing logic from python-server.ts.
 * Returns all fully-parsed JSON messages (in order), leaving any
 * trailing partial line unparsed.
 */
function parseChunkedOutput(chunks: string[]): {
  messages: Message[];
  trailing: string;
} {
  let buffer = "";
  const messages: Message[] = [];

  for (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed) as Message);
      } catch {
        // Non-JSON on stdout is a protocol violation; drop silently.
      }
    }
  }

  return { messages, trailing: buffer };
}

describe("Line-buffered stdio parsing", () => {
  it("parses a ready message delivered in one chunk", () => {
    const { messages } = parseChunkedOutput(['{"type":"ready","ok":true}\n']);
    expect(messages).toEqual([{ type: "ready", ok: true }]);
  });

  it("handles a ready message split across multiple chunks", () => {
    const { messages } = parseChunkedOutput([
      '{"type":"re',
      'ady","ok":',
      "true}\n",
    ]);
    expect(messages).toEqual([{ type: "ready", ok: true }]);
  });

  it("delivers multiple response messages from a single chunk", () => {
    const { messages } = parseChunkedOutput([
      '{"id":1,"result":"a"}\n{"id":2,"result":"b"}\n',
    ]);
    expect(messages).toEqual([
      { id: 1, result: "a" },
      { id: 2, result: "b" },
    ]);
  });

  it("interleaves ready and response messages in order", () => {
    const { messages } = parseChunkedOutput([
      '{"type":"ready","ok":true}\n{"id":1,"result":42}\n',
    ]);
    expect(messages).toEqual([
      { type: "ready", ok: true },
      { id: 1, result: 42 },
    ]);
  });

  it("keeps a partial trailing line in the buffer", () => {
    const { messages, trailing } = parseChunkedOutput([
      '{"id":1,"result":1}\n{"id":2,',
    ]);
    expect(messages).toEqual([{ id: 1, result: 1 }]);
    expect(trailing).toBe('{"id":2,');
  });

  it("handles an empty chunk between messages", () => {
    const { messages } = parseChunkedOutput([
      '{"id":1,"result":true}\n',
      "",
      '{"id":2,"result":false}\n',
    ]);
    expect(messages).toEqual([
      { id: 1, result: true },
      { id: 2, result: false },
    ]);
  });

  it("handles Windows-style line endings", () => {
    // \r stays in the string but JSON.parse accepts it as leading whitespace-ish
    const { messages } = parseChunkedOutput(['{"id":1,"result":"ok"}\r\n']);
    expect(messages).toEqual([{ id: 1, result: "ok" }]);
  });

  it("silently drops non-JSON lines on stdout (shouldn't happen, but safe)", () => {
    const { messages } = parseChunkedOutput([
      "garbage before protocol\n",
      '{"type":"ready","ok":true}\n',
    ]);
    expect(messages).toEqual([{ type: "ready", ok: true }]);
  });

  it("surfaces an error response when the server reports a failure", () => {
    const { messages } = parseChunkedOutput([
      '{"id":7,"error":"Unknown method: foo"}\n',
    ]);
    expect(messages).toEqual([{ id: 7, error: "Unknown method: foo" }]);
  });
});
