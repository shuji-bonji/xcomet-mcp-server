/**
 * Protocol-level tests: drive the shipped `createServer` factory through a
 * real MCP `Client`, in-process.
 *
 * These guard the failure mode that neither `tsc` nor the unit tests can see:
 * if the Zod schemas cannot be converted to JSON Schema (for example when a
 * zod range below 4.2.0 is installed), registration swallows the failure, the
 * server starts and connects normally, and only `tools/list` reports the
 * error. Asserting on `tools/list` here makes that a test failure instead.
 */
import { describe, it, expect } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { createServer } from "../src/server.js";

async function connect(factory: () => McpServer): Promise<Client> {
  const handler = createMcpHandler(factory);
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: "xcomet-test-harness", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  await client.connect(transport);
  return client;
}

describe("MCP protocol surface", () => {
  it("advertises all three tools with converted JSON Schemas", async () => {
    const client = await connect(createServer);
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "xcomet_batch_evaluate",
      "xcomet_detect_errors",
      "xcomet_evaluate",
    ]);

    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
    }

    await client.close();
  });

  it("keeps .describe() text in the advertised input schema", async () => {
    const client = await connect(createServer);
    const { tools } = await client.listTools();

    const evaluate = tools.find((t) => t.name === "xcomet_evaluate");
    const properties = evaluate?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;

    expect(properties?.source?.description).toBe("Original source text");
    expect(properties?.translation?.description).toBe("Translated text to evaluate");

    await client.close();
  });

  it("rejects arguments the schema refuses before the handler runs", async () => {
    const client = await connect(createServer);

    const result = await client.callTool({
      name: "xcomet_evaluate",
      arguments: { source: "", translation: "" },
    });

    expect(result.isError).toBe(true);
    await client.close();
  });

  it("accepts an isError result with no structuredContent on a tool that declares outputSchema", async () => {
    // Mirrors createErrorResponse() in src/tools/index.ts: the error path
    // returns content + isError and omits structuredContent even though the
    // tool advertises an outputSchema.
    const client = await connect(() => {
      const server = new McpServer({ name: "error-path", version: "0.0.0" });
      server.registerTool(
        "always_fails",
        {
          description: "Returns an error result",
          inputSchema: z.object({}),
          outputSchema: z.object({ score: z.number() }),
        },
        async () => ({
          content: [{ type: "text" as const, text: "Error evaluating translation: boom" }],
          isError: true,
        })
      );
      return server;
    });

    const result = await client.callTool({ name: "always_fails", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    await client.close();
  });
});
