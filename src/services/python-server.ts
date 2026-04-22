/**
 * Python Server Manager
 *
 * Manages a persistent Python process for xCOMET inference.
 * Communicates over stdio using a line-delimited JSON-RPC protocol.
 *
 * Protocol (one JSON object per line):
 *   Request:  {"id": <number>, "method": <str>, "params": <obj>}
 *   Response: {"id": <number>, "result": <obj>}  OR  {"id": <number>, "error": <str>}
 *   Ready:    {"type": "ready", "ok": true}       (emitted once at startup)
 *
 * All Python logs go to stderr. stdout is reserved for protocol messages.
 */

import type { ChildProcess } from "child_process";
import { spawn, execFileSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  PYTHON_MAX_RESTARTS,
  PYTHON_HEALTH_CHECK_INTERVAL_MS,
  PYTHON_HEALTH_CHECK_FAILURES_BEFORE_RESTART,
  PYTHON_RESTART_DELAY_MS,
  PYTHON_SERVER_START_TIMEOUT_MS,
  PYTHON_STATS_TIMEOUT_MS,
  PYTHON_KILL_TIMEOUT_MS,
  PYTHON_DEPENDENCY_CHECK_TIMEOUT_MS,
  XCOMET_DEFAULT_MODEL,
  XCOMET_DEFAULT_TIMEOUT_MS,
  HOMEBREW_PYTHON_PATHS,
  REQUIRED_PYTHON_PACKAGES,
} from "../config/constants.js";
import { PythonServerErrors, LogMessages } from "../config/errors.js";

const DEBUG = process.env.XCOMET_DEBUG === "true";

/**
 * Debug logging helper
 */
function debugLog(message: string): void {
  if (DEBUG) {
    console.error(message);
  }
}

/**
 * Always log (errors and important events)
 */
function log(message: string): void {
  console.error(message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PythonServerConfig {
  pythonPath?: string;
  model?: string;
  maxRetries?: number;
  healthCheckInterval?: number;
  maxRestarts?: number;
  preload?: boolean;
}

interface ServerState {
  process: ChildProcess | null;
  ready: boolean;
  starting: boolean;
  error: string | null;
  restartCount: number;
  consecutiveFailures: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface ProtocolResponse {
  id?: number;
  result?: unknown;
  error?: string;
  type?: string;
  ok?: boolean;
}

/**
 * Detect Python path with required dependencies
 */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return join(homedir(), filepath.slice(1));
  }
  return filepath;
}

function detectPythonPath(): string {
  // 1. Check environment variable
  const envPath = process.env.XCOMET_PYTHON_PATH;
  if (envPath) {
    const expanded = expandHome(envPath);
    if (existsSync(expanded)) {
      return expanded;
    }
  }

  const home = homedir();

  // Build import check command from required packages
  const importCheck = REQUIRED_PYTHON_PACKAGES.map((pkg) => `import ${pkg}`).join("; ");

  // 2. Check pyenv versions
  const pyenvDir = join(home, ".pyenv", "versions");
  if (existsSync(pyenvDir)) {
    try {
      const versions = readdirSync(pyenvDir)
        .filter((v: string) => /^\d+\.\d+/.test(v))
        .sort((a: string, b: string) => {
          const aParts = a.split(".").map(Number);
          const bParts = b.split(".").map(Number);
          for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
            const diff = (bParts[i] || 0) - (aParts[i] || 0);
            if (diff !== 0) return diff;
          }
          return 0;
        });

      for (const version of versions) {
        const pythonPath = join(pyenvDir, version, "bin", "python3");
        if (existsSync(pythonPath)) {
          try {
            // Use execFileSync with args array to handle paths with spaces safely
            execFileSync(pythonPath, ["-c", importCheck], {
              timeout: PYTHON_DEPENDENCY_CHECK_TIMEOUT_MS,
              stdio: "ignore",
            });
            return pythonPath;
          } catch {
            // Dependencies not installed
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // 3. Check Homebrew paths
  for (const path of HOMEBREW_PYTHON_PATHS) {
    if (existsSync(path)) {
      try {
        // Use execFileSync with args array to handle paths with spaces safely
        execFileSync(path, ["-c", importCheck], {
          timeout: PYTHON_DEPENDENCY_CHECK_TIMEOUT_MS,
          stdio: "ignore",
        });
        return path;
      } catch {
        // Dependencies not installed
      }
    }
  }

  return "python3";
}

/**
 * Python Server Manager class
 *
 * Spawns and supervises a Python child process that speaks our stdio
 * JSON-RPC protocol. All inference requests are correlated by an integer
 * id so the same process can handle concurrent-looking requests (the
 * Python side serializes them under the GIL, but the Node API stays async).
 */
export class PythonServerManager {
  private state: ServerState = {
    process: null,
    ready: false,
    starting: false,
    error: null,
    restartCount: 0,
    consecutiveFailures: 0,
  };

  private config: Required<PythonServerConfig>;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private isRestarting: boolean = false;

  // Stdio protocol state
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";

  constructor(config: PythonServerConfig = {}) {
    this.config = {
      pythonPath: config.pythonPath || detectPythonPath(),
      model: config.model || process.env.XCOMET_MODEL || XCOMET_DEFAULT_MODEL,
      maxRetries: config.maxRetries ?? 3,
      healthCheckInterval: config.healthCheckInterval ?? PYTHON_HEALTH_CHECK_INTERVAL_MS,
      maxRestarts: config.maxRestarts ?? PYTHON_MAX_RESTARTS,
      preload: config.preload ?? (process.env.XCOMET_PRELOAD?.toLowerCase() === "true"),
    };
  }

  /**
   * Get the path to the Python server script
   */
  private getServerScriptPath(): string {
    // Check multiple possible locations
    const possiblePaths = [
      join(__dirname, "..", "..", "python", "server.py"),
      join(__dirname, "..", "..", "..", "python", "server.py"),
      join(process.cwd(), "python", "server.py"),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    throw new Error(PythonServerErrors.scriptNotFound);
  }

  /**
   * Start the Python server
   */
  async start(): Promise<void> {
    if (this.state.ready) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this._start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async _start(): Promise<void> {
    if (this.state.starting) {
      return;
    }

    this.state.starting = true;
    this.state.error = null;

    const scriptPath = this.getServerScriptPath();

    log(LogMessages.starting(this.config.pythonPath));
    debugLog(`[xcomet] Model: ${this.config.model}`);

    const proc = spawn(this.config.pythonPath, [scriptPath], {
      env: {
        ...process.env,
        XCOMET_MODEL: this.config.model,
        XCOMET_PRELOAD: this.config.preload ? "true" : "false",
        PYTHONWARNINGS: "ignore",
        PYTHONUNBUFFERED: "1",
        TOKENIZERS_PARALLELISM: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.state.process = proc;
    this.stdoutBuffer = "";

    // Wire stdout: buffer incomplete lines, dispatch full JSON lines.
    proc.stdout?.on("data", (data: Buffer) => {
      this.stdoutBuffer += data.toString();
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.dispatchMessage(trimmed);
      }
    });

    // Log stderr (Python logs and warnings)
    proc.stderr?.on("data", (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        debugLog(`[xcomet-python] ${output}`);
      }
    });

    // Wait for the "ready" signal
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waitingForReady = null;
        reject(new Error(PythonServerErrors.startupTimeout));
      }, PYTHON_SERVER_START_TIMEOUT_MS);

      this.waitingForReady = (err) => {
        clearTimeout(timeout);
        this.waitingForReady = null;
        if (err) reject(err);
        else resolve();
      };

      proc.on("error", (err) => {
        clearTimeout(timeout);
        if (this.waitingForReady) {
          const cb = this.waitingForReady;
          this.waitingForReady = null;
          cb(err);
        }
      });

      proc.on("exit", (code, signal) => {
        if (this.waitingForReady) {
          const cb = this.waitingForReady;
          this.waitingForReady = null;
          cb(new Error(PythonServerErrors.exitedWithCode(code)));
        }
        // Reject any in-flight requests
        const exitError = new Error(
          `Python server exited (code=${code}, signal=${signal ?? "none"})`
        );
        this.rejectAllPending(exitError);
      });
    });

    try {
      await readyPromise;
      this.state.ready = true;
      this.state.starting = false;
      log(LogMessages.ready());

      // Start periodic health check
      this.startHealthCheck();

      // Handle process exit (after ready)
      proc.on("exit", (code) => {
        log(LogMessages.exited(code));
        this.state.ready = false;
        this.state.process = null;
        this.stopHealthCheck();
      });
    } catch (error) {
      this.state.starting = false;
      this.state.error = error instanceof Error ? error.message : String(error);

      // Kill orphaned process to prevent resource leak
      if (proc && !proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // Ignore kill errors (process may have already exited)
        }
      }
      this.state.process = null;

      throw error;
    }
  }

  /**
   * Optional callback for the "ready" signal. Set during _start().
   */
  private waitingForReady: ((err?: Error) => void) | null = null;

  /**
   * Parse and dispatch a single JSON line from the child's stdout.
   */
  private dispatchMessage(line: string): void {
    let msg: ProtocolResponse;
    try {
      msg = JSON.parse(line) as ProtocolResponse;
    } catch {
      debugLog(`[xcomet-python] (non-JSON stdout) ${line}`);
      return;
    }

    // "ready" signal
    if (msg.type === "ready") {
      if (this.waitingForReady) {
        if (msg.ok) {
          this.waitingForReady();
        } else {
          this.waitingForReady(new Error(msg.error ?? "Python server reported not ready"));
        }
      }
      return;
    }

    // Response to a pending request
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        debugLog(`[xcomet] Received response for unknown request id=${msg.id}`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      if (msg.error !== undefined) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    debugLog(`[xcomet-python] (unhandled message) ${line}`);
  }

  /**
   * Reject all pending requests with the given error (used on process exit).
   */
  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Stop the Python server
   */
  async stop(): Promise<void> {
    this.stopHealthCheck();

    const proc = this.state.process;
    if (!proc) {
      return;
    }

    log(LogMessages.stopping);

    // Graceful shutdown: closing stdin causes the server's main loop to
    // exit on EOF. No /shutdown endpoint needed.
    try {
      proc.stdin?.end();
    } catch {
      // Already closed
    }

    // Wait for process to exit or kill it
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already exited
        }
        resolve();
      }, PYTHON_KILL_TIMEOUT_MS);

      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      // SIGTERM as a courtesy nudge (EOF on stdin should already trigger exit)
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited
      }
    });

    // Reject any still-pending requests
    this.rejectAllPending(new Error("Python server stopped"));

    this.state.process = null;
    this.state.ready = false;
  }

  /**
   * Send a request to the Python server and await a correlated response.
   *
   * @param method  RPC method name (e.g. "evaluate", "detect_errors", "batch_evaluate", "health", "stats")
   * @param params  Method parameters (sent as the `params` object)
   * @param timeout Per-request timeout in milliseconds
   */
  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeout: number = XCOMET_DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    // Ensure server is started
    await this.start();

    const proc = this.state.process;
    if (!proc || !proc.stdin || proc.stdin.destroyed) {
      throw new Error(PythonServerErrors.notRunning);
    }

    const id = this.nextRequestId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(PythonServerErrors.requestTimeout));
        }
      }, timeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });

      const payload = JSON.stringify({ id, method, params }) + "\n";
      try {
        proc.stdin!.write(payload, (err) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Health check - lightweight ping that also returns model load state.
   */
  async healthCheck(): Promise<{ status: string; model_loaded: boolean; model_name: string }> {
    return this.request("health", {}, PYTHON_STATS_TIMEOUT_MS);
  }

  /**
   * Start periodic health checks
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.healthCheck();
        // Reset consecutive failures on success
        this.state.consecutiveFailures = 0;
      } catch (error) {
        this.state.consecutiveFailures++;
        log(
          LogMessages.healthCheckFailed(
            this.state.consecutiveFailures,
            PYTHON_HEALTH_CHECK_FAILURES_BEFORE_RESTART,
            error
          )
        );

        // Auto-restart after consecutive failures
        if (this.state.consecutiveFailures >= PYTHON_HEALTH_CHECK_FAILURES_BEFORE_RESTART) {
          await this.attemptRestart();
        }
      }
    }, this.config.healthCheckInterval);
  }

  /**
   * Attempt to restart the server
   */
  private async attemptRestart(): Promise<void> {
    if (this.isRestarting) {
      return;
    }

    if (this.state.restartCount >= this.config.maxRestarts) {
      log(PythonServerErrors.maxRestartsReached(this.config.maxRestarts));
      return;
    }

    this.isRestarting = true;
    this.state.restartCount++;
    log(LogMessages.attemptingRestart(this.state.restartCount, this.config.maxRestarts));

    try {
      // Stop the current server
      this.stopHealthCheck();
      if (this.state.process) {
        try {
          this.state.process.stdin?.end();
        } catch {
          // Ignore
        }
        this.state.process.kill("SIGTERM");
        this.state.process = null;
      }
      this.rejectAllPending(new Error("Python server is restarting"));
      this.state.ready = false;
      this.state.consecutiveFailures = 0;

      // Wait a bit before restarting
      await new Promise((resolve) => setTimeout(resolve, PYTHON_RESTART_DELAY_MS));

      // Start a new server
      await this._start();
      log(LogMessages.restartSuccessful);
    } catch (error) {
      log(LogMessages.restartFailed(error));
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * Stop health checks
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Check if server is ready
   */
  isReady(): boolean {
    return this.state.ready;
  }

  /**
   * Get Python path being used
   */
  getPythonPath(): string {
    return this.config.pythonPath;
  }

  /**
   * Get model being used
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * Get server statistics
   */
  async getStats(): Promise<{
    uptime_seconds: number | null;
    model_loaded: boolean;
    model_load_time_ms: number | null;
    evaluate_rpc_count: number;
    detect_errors_rpc_count: number;
    batch_rpc_count: number;
    total_pairs_evaluated: number;
    total_inference_time_ms: number;
    avg_inference_time_ms: number | null;
  }> {
    return this.request("stats", {}, PYTHON_STATS_TIMEOUT_MS);
  }

  /**
   * Get restart count
   */
  getRestartCount(): number {
    return this.state.restartCount;
  }
}

// Singleton instance
let _serverManager: PythonServerManager | null = null;

export function getServerManager(config?: PythonServerConfig): PythonServerManager {
  if (!_serverManager) {
    _serverManager = new PythonServerManager(config);
  }
  return _serverManager;
}

export async function shutdownServer(): Promise<void> {
  if (_serverManager) {
    await _serverManager.stop();
    _serverManager = null;
  }
}
