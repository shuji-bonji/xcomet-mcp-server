import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools/index.js";
import { SERVER_NAME, SERVER_VERSION } from "./config/constants.js";

/**
 * Create and configure the MCP server.
 *
 * This is the factory the stdio entry point hands to `serveStdio`, and the
 * same factory the protocol tests drive in-process through `createMcpHandler`.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register all tools
  registerTools(server);

  return server;
}
