#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { shutdownServer } from "./services/xcomet.js";
import { SERVER_NAME, SERVER_VERSION } from "./config/constants.js";
import { LogMessages } from "./config/errors.js";
import { logger } from "./utils/logger.js";

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

  // Log to stderr (via logger) to avoid interfering with stdio communication
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(LogMessages.shutdownSignal(signal));
  try {
    await shutdownServer();
    logger.info(LogMessages.shutdownComplete);
    process.exit(0);
  } catch (error) {
    logger.error(LogMessages.shutdownError(error));
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
    logger.error(`Server error: ${error instanceof Error ? error.message : String(error)}`);
    await shutdownServer();
    process.exit(1);
  }
}

// Run the server
main();
