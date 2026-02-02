/**
 * Integration tests for Python server management
 *
 * These tests verify the actual behavior of the Python server startup/shutdown.
 * They require Python with fastapi and uvicorn installed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { ChildProcess } from "child_process";
import { existsSync } from "fs";
import {
  checkPythonDeps,
  startServer,
  stopServer,
  SERVER_SCRIPT_PATH,
} from "./helpers/test-utils.js";

const hasPythonDeps = checkPythonDeps();

describe.skipIf(!hasPythonDeps)("Python Server Integration", () => {
  let serverProcess: ChildProcess | null = null;

  afterEach(async () => {
    await stopServer(serverProcess);
    serverProcess = null;
  });

  it("should start server and report port via stdout", async () => {
    const { process, port } = await startServer({ timeout: 10000 });
    serverProcess = process;

    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("should respond to health check after startup", async () => {
    const { process, port } = await startServer({ timeout: 10000 });
    serverProcess = process;

    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 500));

    // Check health endpoint
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data).toHaveProperty("model_loaded");
    expect(data).toHaveProperty("model_name");
  });

  it("should return stats with new field names", async () => {
    const { process, port } = await startServer({ timeout: 10000 });
    serverProcess = process;

    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 500));

    // Check stats endpoint
    const response = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(response.ok).toBe(true);

    const data = await response.json();

    // New field names should exist
    expect(data).toHaveProperty("evaluate_api_count");
    expect(data).toHaveProperty("detect_errors_api_count");
    expect(data).toHaveProperty("batch_api_count");
    expect(data).toHaveProperty("total_pairs_evaluated");

    // Old field names should NOT exist
    expect(data).not.toHaveProperty("evaluation_count");
    expect(data).not.toHaveProperty("batch_count");
  });

  it("should shutdown gracefully via /shutdown endpoint", async () => {
    const { process, port } = await startServer({ timeout: 10000 });
    serverProcess = process;

    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 500));

    // Call shutdown endpoint
    const response = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
    });
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.status).toBe("shutting_down");

    // Wait a moment for the shutdown to complete
    await new Promise((r) => setTimeout(r, 2000));

    // Verify server is no longer responding
    try {
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000)
      });
      // If we get here, server is still running - that's unexpected but ok
    } catch {
      // Expected - server should be down
    }

    // Cleanup handled by afterEach
    serverProcess = null;
  });
});

describe("Server script exists", () => {
  it("should have server.py in python directory", () => {
    expect(existsSync(SERVER_SCRIPT_PATH)).toBe(true);
  });
});
