#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { registerTools } from "./tools/index.js";
import { shutdownServer } from "./services/xcomet.js";
import {
  SERVER_NAME,
  SERVER_VERSION,
  DEFAULT_HTTP_PORT,
  DEFAULT_BODY_LIMIT,
  DEFAULT_TRANSPORT,
} from "./config/constants.js";
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
 * Run server with HTTP transport (for remote access)
 */
async function runHTTP(): Promise<void> {
  const server = createServer();
  const app = express();

  const bodyLimit = process.env.MCP_BODY_LIMIT || DEFAULT_BODY_LIMIT;
  app.use(express.json({ limit: bodyLimit }));

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
    });
  });

  // MCP endpoint
  app.post("/mcp", async (req, res, next) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("HTTP server error:", err);
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ error: "Internal Server Error" });
  });

  const port = parseInt(process.env.PORT || String(DEFAULT_HTTP_PORT), 10);

  app.listen(port, () => {
    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on http://localhost:${port}/mcp`);
  });
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
  const transport = process.env.TRANSPORT || DEFAULT_TRANSPORT;

  // Register shutdown handlers
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  try {
    if (transport === "http") {
      await runHTTP();
    } else {
      await runStdio();
    }
  } catch (error) {
    console.error("Server error:", error);
    await shutdownServer();
    process.exit(1);
  }
}

// Run the server
main();
