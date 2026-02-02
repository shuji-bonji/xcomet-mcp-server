/**
 * Shared test utilities for xCOMET MCP Server tests
 *
 * This module provides common helpers to reduce code duplication
 * across test files.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the Python server script */
export const SERVER_SCRIPT_PATH = join(__dirname, "..", "..", "python", "server.py");

/** Default timeout for server startup in milliseconds */
export const SERVER_STARTUP_TIMEOUT_MS = 15000;

/** Default timeout for server ready check in milliseconds */
export const SERVER_READY_TIMEOUT_MS = 500;

/** Default interval for server ready polling in milliseconds */
export const SERVER_READY_POLL_INTERVAL_MS = 100;

/** Default max attempts for server ready check */
export const SERVER_READY_MAX_ATTEMPTS = 50;

/** Timeout for process cleanup in milliseconds */
export const PROCESS_CLEANUP_TIMEOUT_MS = 3000;

/**
 * Server instance returned by startServer helper
 */
export interface ServerInstance {
  process: ChildProcess;
  port: number;
}

/**
 * Check if Python dependencies (fastapi, uvicorn) are available
 * @returns true if dependencies are installed, false otherwise
 */
export function checkPythonDeps(): boolean {
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

/**
 * Start the Python server and wait for it to report its port
 *
 * @param options Configuration options
 * @param options.timeout Timeout for server startup (default: 15000ms)
 * @param options.env Additional environment variables
 * @returns Server instance with process and port
 */
export async function startServer(options: {
  timeout?: number;
  env?: Record<string, string>;
} = {}): Promise<ServerInstance> {
  const { timeout = SERVER_STARTUP_TIMEOUT_MS, env = {} } = options;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error("Timeout waiting for server to start"));
    }, timeout);

    const proc = spawn("python3", [SERVER_SCRIPT_PATH], {
      env: { ...process.env, PORT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const json = JSON.parse(trimmed);
          if (json.port) {
            clearTimeout(timeoutId);
            resolve({ process: proc, port: json.port });
            return;
          }
        } catch {
          // Not JSON, continue
        }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    proc.on("exit", (code) => {
      clearTimeout(timeoutId);
      reject(new Error(`Server exited with code ${code}`));
    });
  });
}

/**
 * Wait for the server to be ready by polling the health endpoint
 *
 * @param port Server port
 * @param options Configuration options
 * @param options.maxAttempts Maximum number of polling attempts
 * @param options.pollInterval Interval between polling attempts in milliseconds
 * @param options.timeout Timeout for each health check request
 */
export async function waitForServerReady(
  port: number,
  options: {
    maxAttempts?: number;
    pollInterval?: number;
    timeout?: number;
  } = {}
): Promise<void> {
  const {
    maxAttempts = SERVER_READY_MAX_ATTEMPTS,
    pollInterval = SERVER_READY_POLL_INTERVAL_MS,
    timeout = SERVER_READY_TIMEOUT_MS,
  } = options;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(`Server did not become ready after ${maxAttempts} attempts`);
}

/**
 * Stop a server process gracefully with fallback to force kill
 *
 * @param proc Child process to stop
 * @param timeout Timeout before force kill (default: 3000ms)
 */
export async function stopServer(
  proc: ChildProcess | null,
  timeout: number = PROCESS_CLEANUP_TIMEOUT_MS
): Promise<void> {
  if (!proc) return;

  return new Promise<void>((resolve) => {
    const timeoutId = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, timeout);

    proc.on("exit", () => {
      clearTimeout(timeoutId);
      resolve();
    });

    proc.kill("SIGTERM");
  });
}

/**
 * Create a server lifecycle manager for use in beforeAll/afterAll hooks
 *
 * @example
 * ```typescript
 * const serverLifecycle = createServerLifecycle();
 *
 * beforeAll(async () => {
 *   await serverLifecycle.start();
 * }, 30000);
 *
 * afterAll(async () => {
 *   await serverLifecycle.stop();
 * });
 *
 * it("should work", async () => {
 *   const port = serverLifecycle.port;
 *   // ... test code
 * });
 * ```
 */
export function createServerLifecycle() {
  let serverProcess: ChildProcess | null = null;
  let serverPort: number | null = null;

  return {
    /**
     * Start the server and wait for it to be ready
     */
    async start(options: { env?: Record<string, string> } = {}): Promise<void> {
      const { process, port } = await startServer(options);
      serverProcess = process;
      serverPort = port;
      await waitForServerReady(port);
    },

    /**
     * Stop the server
     */
    async stop(): Promise<void> {
      await stopServer(serverProcess);
      serverProcess = null;
      serverPort = null;
    },

    /**
     * Get the server port (throws if not started)
     */
    get port(): number {
      if (serverPort === null) {
        throw new Error("Server not started");
      }
      return serverPort;
    },

    /**
     * Get the server process (may be null)
     */
    get process(): ChildProcess | null {
      return serverProcess;
    },
  };
}

/**
 * Custom matcher for Vitest: toBeOneOf
 * Checks if the received value is one of the expected values
 */
export const toBeOneOfMatcher = {
  toBeOneOf(received: unknown, expected: unknown[]) {
    const pass = expected.includes(received);
    return {
      pass,
      message: () =>
        pass
          ? `expected ${received} not to be one of ${JSON.stringify(expected)}`
          : `expected ${received} to be one of ${JSON.stringify(expected)}`,
    };
  },
};

/**
 * Type augmentation for Vitest to support toBeOneOf matcher
 */
declare module "vitest" {
  interface Assertion<T> {
    toBeOneOf(expected: unknown[]): void;
  }
  interface AsymmetricMatchersContaining {
    toBeOneOf(expected: unknown[]): void;
  }
}
