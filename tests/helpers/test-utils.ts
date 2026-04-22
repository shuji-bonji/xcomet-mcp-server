/**
 * Shared test utilities for xCOMET MCP Server tests
 *
 * This module provides common helpers to reduce code duplication
 * across test files. All helpers speak the stdio JSON-RPC protocol
 * (one JSON object per line) used by python/server.py.
 */

import type { ChildProcess } from "child_process";
import { spawn, execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the Python server script */
export const SERVER_SCRIPT_PATH = join(__dirname, "..", "..", "python", "server.py");

/** Default timeout for server startup in milliseconds */
export const SERVER_STARTUP_TIMEOUT_MS = 15000;

/** Timeout for process cleanup in milliseconds */
export const PROCESS_CLEANUP_TIMEOUT_MS = 3000;

/** Default timeout for individual RPC requests in milliseconds */
export const RPC_REQUEST_TIMEOUT_MS = 120000;

/**
 * Server instance returned by startServer helper
 *
 * `client.request(method, params)` sends a single RPC and returns the response.
 */
export interface ServerInstance {
  process: ChildProcess;
  client: StdioRpcClient;
}

/**
 * Minimal stdio JSON-RPC client, matching the protocol spoken by python/server.py:
 *   Request:  {"id": <number>, "method": <str>, "params": <obj>}
 *   Response: {"id": <number>, "result": <obj>}  OR  {"id": <number>, "error": <str>}
 */
export class StdioRpcClient {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly process: ChildProcess, initialBuffer: string = "") {
    this.buffer = initialBuffer;
    process.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    process.on("exit", (code, signal) => {
      const err = new Error(
        `Python server exited (code=${code}, signal=${signal ?? "none"})`
      );
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: { id?: number; result?: unknown; error?: string };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // Ignore non-JSON lines (shouldn't happen on stdout, but be defensive)
        continue;
      }

      if (typeof msg.id !== "number") continue; // "ready" etc. are handled elsewhere
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error !== undefined) {
        p.reject(new Error(msg.error));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  /**
   * Send an RPC request and await its correlated response.
   */
  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeout: number = RPC_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}#${id}`));
        }
      }, timeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const payload = JSON.stringify({ id, method, params }) + "\n";
      try {
        this.process.stdin?.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

/**
 * Check if the Python `comet` package is importable.
 *
 * (We no longer need fastapi/uvicorn — stdio only needs `unbabel-comet`.)
 */
export function checkPythonDeps(): boolean {
  try {
    execSync('python3 -c "import comet"', {
      timeout: 5000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the Python server and wait for the `{"type":"ready","ok":true}` signal.
 */
export async function startServer(
  options: {
    timeout?: number;
    env?: Record<string, string>;
  } = {}
): Promise<ServerInstance> {
  const { timeout = SERVER_STARTUP_TIMEOUT_MS, env = {} } = options;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error("Timeout waiting for server to start"));
    }, timeout);

    const proc = spawn("python3", [SERVER_SCRIPT_PATH], {
      env: { ...process.env, PYTHONUNBUFFERED: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let readyReceived = false;

    proc.stdout?.on("data", (data: Buffer) => {
      if (readyReceived) return; // Further messages belong to the RPC client
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const json = JSON.parse(trimmed) as {
            type?: string;
            ok?: boolean;
            error?: string;
          };
          if (json.type === "ready") {
            clearTimeout(timeoutId);
            readyReceived = true;
            if (json.ok) {
              // Attach RPC client after "ready"; any leftover partial buffer is
              // handed to the client so it picks up from where we left off.
              const client = new StdioRpcClient(proc, stdoutBuffer);
              stdoutBuffer = "";
              resolve({ process: proc, client });
            } else {
              reject(new Error(json.error ?? "Server reported not ready"));
            }
            return;
          }
        } catch {
          // Non-JSON on stdout before ready is unexpected, ignore
        }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    proc.on("exit", (code) => {
      if (!readyReceived) {
        clearTimeout(timeoutId);
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}

/**
 * Stop a server process gracefully (close stdin → SIGTERM → SIGKILL fallback).
 */
export async function stopServer(
  proc: ChildProcess | null,
  timeout: number = PROCESS_CLEANUP_TIMEOUT_MS
): Promise<void> {
  if (!proc) return;

  return new Promise<void>((resolve) => {
    const timeoutId = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited
      }
      resolve();
    }, timeout);

    proc.on("exit", () => {
      clearTimeout(timeoutId);
      resolve();
    });

    try {
      proc.stdin?.end();
    } catch {
      // Already closed
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already exited
    }
  });
}

/**
 * Create a server lifecycle manager for use in beforeAll/afterAll hooks.
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
 *   const result = await serverLifecycle.client.request("evaluate", { ... });
 * });
 * ```
 */
export function createServerLifecycle() {
  let serverProcess: ChildProcess | null = null;
  let serverClient: StdioRpcClient | null = null;

  return {
    async start(options: { env?: Record<string, string> } = {}): Promise<void> {
      const { process, client } = await startServer(options);
      serverProcess = process;
      serverClient = client;
    },

    async stop(): Promise<void> {
      await stopServer(serverProcess);
      serverProcess = null;
      serverClient = null;
    },

    /** RPC client (throws if not started) */
    get client(): StdioRpcClient {
      if (!serverClient) {
        throw new Error("Server not started");
      }
      return serverClient;
    },

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
  // Generic parameter T must match Vitest's signature even when unused
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<T> {
    toBeOneOf(expected: unknown[]): void;
  }
  interface AsymmetricMatchersContaining {
    toBeOneOf(expected: unknown[]): void;
  }
}
