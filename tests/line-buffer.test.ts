/**
 * Tests for line-buffered stdout parsing (Fix #1: Port detection chunking)
 */
import { describe, it, expect } from "vitest";

/**
 * Simulates the line-buffered parsing logic from python-server.ts
 */
function parseChunkedOutput(chunks: string[]): { port: number | null; logs: string[] } {
  let stdoutBuffer = "";
  let port: number | null = null;
  const logs: string[] = [];

  for (const chunk of chunks) {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const json = JSON.parse(trimmed);
        if (json.port) {
          port = json.port;
        }
      } catch {
        // Not JSON, log it
        logs.push(trimmed);
      }
    }
  }

  return { port, logs };
}

describe("Line-buffered stdout parsing", () => {
  it("should parse complete JSON in single chunk", () => {
    const chunks = ['{"port": 12345}\n'];
    const result = parseChunkedOutput(chunks);
    expect(result.port).toBe(12345);
    expect(result.logs).toEqual([]);
  });

  it("should handle JSON split across multiple chunks", () => {
    const chunks = ['{"por', 't": 123', '45}\n'];
    const result = parseChunkedOutput(chunks);
    expect(result.port).toBe(12345);
    expect(result.logs).toEqual([]);
  });

  it("should handle JSON with preceding log output", () => {
    const chunks = [
      "[xcomet-server] Starting...\n",
      '{"port": 54321}\n',
    ];
    const result = parseChunkedOutput(chunks);
    expect(result.port).toBe(54321);
    expect(result.logs).toContain("[xcomet-server] Starting...");
  });

  it("should handle multiple lines in single chunk", () => {
    const chunks = ['log line 1\nlog line 2\n{"port": 9999}\n'];
    const result = parseChunkedOutput(chunks);
    expect(result.port).toBe(9999);
    expect(result.logs).toContain("log line 1");
    expect(result.logs).toContain("log line 2");
  });

  it("should handle chunk boundary in the middle of JSON", () => {
    // Simulates network/pipe buffering splitting JSON awkwardly
    const chunks = [
      'some log\n{"port"',
      ": ",
      "8080",
      "}\nmore log\n",
    ];
    const result = parseChunkedOutput(chunks);
    expect(result.port).toBe(8080);
    expect(result.logs).toContain("some log");
    expect(result.logs).toContain("more log");
  });

  it("should ignore incomplete JSON at end of stream", () => {
    const chunks = ['{"port": 1234}\n{"incomplete'];
    const result = parseChunkedOutput(chunks);
    expect(result.port).toBe(1234);
    // Incomplete JSON remains in buffer, not logged
  });

  it("should handle empty chunks", () => {
    const chunks = ["", '{"port": 5555}\n', ""];
    const result = parseChunkedOutput(chunks);
    expect(result.port).toBe(5555);
  });

  it("should handle Windows-style line endings", () => {
    const chunks = ['{"port": 7777}\r\n'];
    const result = parseChunkedOutput(chunks);
    // Note: \r will be included in the line, but JSON.parse handles it
    expect(result.port).toBe(7777);
  });

  it("should handle no port in output", () => {
    const chunks = ["just logs\nno json here\n"];
    const result = parseChunkedOutput(chunks);
    expect(result.port).toBeNull();
    expect(result.logs).toContain("just logs");
    expect(result.logs).toContain("no json here");
  });
});
