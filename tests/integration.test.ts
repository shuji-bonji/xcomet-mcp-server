/**
 * Integration tests for Python server management (stdio JSON-RPC)
 *
 * These tests verify that the stdio-based Python server:
 *   - emits the `{"type":"ready","ok":true}` signal on startup
 *   - responds to `health` and `stats` RPCs
 *   - shuts down cleanly when stdin is closed
 *
 * Requires Python with the `comet` package installed. The whole suite
 * is skipped when dependencies are not available.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ChildProcess } from "child_process";
import { existsSync } from "fs";
import {
  checkPythonDeps,
  startServer,
  stopServer,
  SERVER_SCRIPT_PATH,
} from "./helpers/test-utils.js";

const hasPythonDeps = checkPythonDeps();

describe.skipIf(!hasPythonDeps)("Python Server Integration (stdio)", () => {
  let serverProcess: ChildProcess | null = null;

  afterEach(async () => {
    await stopServer(serverProcess);
    serverProcess = null;
  });

  it("should emit the ready signal on startup", async () => {
    const { process } = await startServer({ timeout: 10000 });
    serverProcess = process;
    // If startServer resolved, the ready signal was received.
    expect(process.killed).toBe(false);
  });

  it("should respond to the health RPC", async () => {
    const { process, client } = await startServer({ timeout: 10000 });
    serverProcess = process;

    const data = await client.request<{
      status: string;
      model_loaded: boolean;
      model_name: string;
    }>("health");

    expect(data.status).toBe("ok");
    expect(data).toHaveProperty("model_loaded");
    expect(data).toHaveProperty("model_name");
  });

  it("should return stats with RPC-style field names", async () => {
    const { process, client } = await startServer({ timeout: 10000 });
    serverProcess = process;

    const data = await client.request<Record<string, unknown>>("stats");

    // New RPC-style field names should exist
    expect(data).toHaveProperty("evaluate_rpc_count");
    expect(data).toHaveProperty("detect_errors_rpc_count");
    expect(data).toHaveProperty("batch_rpc_count");
    expect(data).toHaveProperty("total_pairs_evaluated");

    // Legacy HTTP-era field names should NOT exist
    expect(data).not.toHaveProperty("evaluate_api_count");
    expect(data).not.toHaveProperty("detect_errors_api_count");
    expect(data).not.toHaveProperty("batch_api_count");
  });

  it("should shutdown gracefully when stdin is closed", async () => {
    const { process } = await startServer({ timeout: 10000 });
    serverProcess = process;

    const exited = new Promise<number | null>((resolve) => {
      process.on("exit", (code) => resolve(code));
    });

    // Close stdin to signal graceful shutdown (EOF)
    process.stdin?.end();

    // Wait for the server to exit (allow generous time for model teardown)
    const code = await Promise.race([
      exited,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(-1), 5000)),
    ]);

    // 0 = clean exit; some Python versions may return null when signaled.
    // The key thing is that it exited without us having to SIGKILL.
    expect(code).not.toBe(-1);
    serverProcess = null; // exited; skip cleanup
  });

  it("should reject unknown methods with an error response", async () => {
    const { process, client } = await startServer({ timeout: 10000 });
    serverProcess = process;

    await expect(client.request("this_method_does_not_exist")).rejects.toThrow(
      /Unknown method/
    );
  });
});

describe("Server script exists", () => {
  it("should have server.py in python directory", () => {
    expect(existsSync(SERVER_SCRIPT_PATH)).toBe(true);
  });
});
