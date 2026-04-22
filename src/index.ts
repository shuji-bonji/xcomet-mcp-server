#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { shutdownServer } from "./services/xcomet.js";
import { SERVER_NAME, SERVER_VERSION } from "./config/constants.js";
import { LogMessages } from "./config/errors.js";

/**
 * Create and configure the MCP server
 */
function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register all tools
  registerTools(server);

  return server;
}

/**
 * Run server with stdio transport (for Claude Desktop, Claude Code, etc.)
 */
async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Log to stderr to avoid interfering with stdio communication
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal: string): Promise<void> {
  console.error(LogMessages.shutdownSignal(signal));
  try {
    await shutdownServer();
    console.error(LogMessages.shutdownComplete);
    process.exit(0);
  } catch (error) {
    console.error(LogMessages.shutdownError(error));
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Register shutdown handlers
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  try {
    await runStdio();
  } catch (error) {
    console.error("Server error:", error);
    await shutdownServer();
    process.exit(1);
  }
}

// Run the server
main();
