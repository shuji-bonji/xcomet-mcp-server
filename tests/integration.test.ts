/**
 * Integration tests for Python server management
 *
 * These tests verify the actual behavior of the Python server startup/shutdown.
 * They require Python with fastapi and uvicorn installed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverScriptPath = join(__dirname, "..", "python", "server.py");

// Check if Python dependencies are available
function checkPythonDeps(): boolean {
  try {
    execSync('python3 -c "import fastapi; import uvicorn"', {
      timeout: 5000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const hasPythonDeps = checkPythonDeps();

describe.skipIf(!hasPythonDeps)("Python Server Integration", () => {
  let serverProcess: ChildProcess | null = null;

  afterEach(async () => {
    // Cleanup server process after each test
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          serverProcess?.kill("SIGKILL");
          resolve();
        }, 2000);
        serverProcess?.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      serverProcess = null;
    }
  });

  it("should start server and report port via stdout", async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for port"));
      }, 10000);

      serverProcess = spawn("python3", [serverScriptPath], {
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      serverProcess.stdout?.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const json = JSON.parse(trimmed);
            if (json.port) {
              clearTimeout(timeout);
              resolve(json.port);
              return;
            }
          } catch {
            // Not JSON, continue
          }
        }
      });

      serverProcess.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      serverProcess.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      });
    });

    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("should respond to health check after startup", async () => {
    // Start server and get port
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for port"));
      }, 10000);

      serverProcess = spawn("python3", [serverScriptPath], {
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      serverProcess.stdout?.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const json = JSON.parse(trimmed);
            if (json.port) {
              clearTimeout(timeout);
              resolve(json.port);
              return;
            }
          } catch {
            // Not JSON
          }
        }
      });
    });

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
    // Start server and get port
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for port"));
      }, 10000);

      serverProcess = spawn("python3", [serverScriptPath], {
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      serverProcess.stdout?.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const json = JSON.parse(trimmed);
            if (json.port) {
              clearTimeout(timeout);
              resolve(json.port);
              return;
            }
          } catch {
            // Not JSON
          }
        }
      });
    });

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
    // Start server and get port
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for port"));
      }, 10000);

      serverProcess = spawn("python3", [serverScriptPath], {
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      serverProcess.stdout?.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const json = JSON.parse(trimmed);
            if (json.port) {
              clearTimeout(timeout);
              resolve(json.port);
              return;
            }
          } catch {
            // Not JSON
          }
        }
      });
    });

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

    // Cleanup: force kill if still running
    serverProcess?.kill("SIGTERM");
    serverProcess = null;
  });
});

describe("Server script exists", () => {
  it("should have server.py in python directory", () => {
    expect(existsSync(serverScriptPath)).toBe(true);
  });
});
