#!/usr/bin/env node
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";
import { shutdownServer } from "./services/xcomet.js";
import { SERVER_NAME, SERVER_VERSION } from "./config/constants.js";
import { LogMessages } from "./config/errors.js";
import { logger } from "./utils/logger.js";

/**
 * Handle returned by serveStdio. Closed first on shutdown so the transport
 * is torn down before the Python worker is stopped.
 */
let stdioHandle: StdioServerHandle | undefined;

/**
 * Run server with stdio transport (for Claude Desktop, Claude Code, etc.)
 *
 * serveStdio owns the transport and the protocol era decision: the opening
 * exchange selects the era, one instance from the factory is pinned for the
 * connection lifetime, and 2025-era clients are served from the same factory
 * (`legacy: 'serve'` is the default).
 */
function runStdio(): void {
  stdioHandle = serveStdio(() => createServer(), {
    onerror: (error) => logger.error(`stdio transport error: ${error.message}`),
  });

  // Log to stderr (via logger) to avoid interfering with stdio communication
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(LogMessages.shutdownSignal(signal));
  try {
    await stdioHandle?.close();
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
    runStdio();
  } catch (error) {
    logger.error(`Server error: ${error instanceof Error ? error.message : String(error)}`);
    await shutdownServer();
    process.exit(1);
  }
}

// Run the server
main();
