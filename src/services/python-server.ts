/**
 * Python Server Manager
 * Manages a persistent Python FastAPI server for xCOMET inference.
 */

import { spawn, ChildProcess, execFileSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  PYTHON_MAX_RETRIES,
  PYTHON_HEALTH_CHECK_INTERVAL_MS,
  PYTHON_MAX_RESTARTS,
  PYTHON_HEALTH_CHECK_FAILURES_BEFORE_RESTART,
  PYTHON_RESTART_DELAY_MS,
  PYTHON_SERVER_START_TIMEOUT_MS,
  PYTHON_SERVER_READY_POLL_INTERVAL_MS,
  PYTHON_SERVER_READY_MAX_ATTEMPTS,
  PYTHON_HEALTH_CHECK_TIMEOUT_MS,
  PYTHON_STATS_TIMEOUT_MS,
  PYTHON_SHUTDOWN_TIMEOUT_MS,
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
  port: number | null;
  ready: boolean;
  starting: boolean;
  error: string | null;
  restartCount: number;
  consecutiveFailures: number;
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
  const importCheck = REQUIRED_PYTHON_PACKAGES.map(pkg => `import ${pkg}`).join("; ");

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
 */
export class PythonServerManager {
  private state: ServerState = {
    process: null,
    port: null,
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

  constructor(config: PythonServerConfig = {}) {
    this.config = {
      pythonPath: config.pythonPath || detectPythonPath(),
      model: config.model || process.env.XCOMET_MODEL || XCOMET_DEFAULT_MODEL,
      maxRetries: config.maxRetries ?? PYTHON_MAX_RETRIES,
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
        PORT: "0", // Let the server pick a random port
        XCOMET_MODEL: this.config.model,
        XCOMET_PRELOAD: this.config.preload ? "true" : "false",
        PYTHONWARNINGS: "ignore",
        TOKENIZERS_PARALLELISM: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.state.process = proc;

    // Handle stdout to get the port (line-buffered for chunked JSON)
    let portReceived = false;
    let stdoutBuffer = "";
    const portPromise = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!portReceived) {
          reject(new Error(PythonServerErrors.startupTimeout));
        }
      }, PYTHON_SERVER_START_TIMEOUT_MS);

      proc.stdout?.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const json = JSON.parse(trimmed);
            if (json.port) {
              portReceived = true;
              clearTimeout(timeout);
              resolve(json.port);
              return;
            }
          } catch {
            // Not JSON, log and continue
            debugLog(`[xcomet-python] ${trimmed}`);
          }
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.on("exit", (code) => {
        if (!portReceived) {
          clearTimeout(timeout);
          reject(new Error(PythonServerErrors.exitedWithCode(code)));
        }
      });
    });

    // Log stderr
    proc.stderr?.on("data", (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        debugLog(`[xcomet-python] ${output}`);
      }
    });

    try {
      const port = await portPromise;
      this.state.port = port;
      log(LogMessages.portReported(port));

      // Wait for server to actually be ready (uvicorn takes a moment to start listening)
      await this.waitForServerReady(port);

      this.state.ready = true;
      this.state.starting = false;
      log(LogMessages.ready(port));

      // Start health check
      this.startHealthCheck();

      // Handle process exit
      proc.on("exit", (code) => {
        log(LogMessages.exited(code));
        this.state.ready = false;
        this.state.process = null;
        this.state.port = null;
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
      this.state.port = null;

      throw error;
    }
  }

  /**
   * Wait for server to be ready by polling the health endpoint
   */
  private async waitForServerReady(port: number, maxAttempts: number = PYTHON_SERVER_READY_MAX_ATTEMPTS): Promise<void> {
    const url = `http://127.0.0.1:${port}/health`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PYTHON_HEALTH_CHECK_TIMEOUT_MS);

        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          debugLog(`[xcomet] Server ready after ${attempt} attempt(s)`);
          return;
        }
      } catch {
        // Server not ready yet, wait and retry
      }

      // Wait before next attempt
      await new Promise((resolve) => setTimeout(resolve, PYTHON_SERVER_READY_POLL_INTERVAL_MS));
    }

    throw new Error(PythonServerErrors.readyTimeout(maxAttempts));
  }

  /**
   * Stop the Python server
   */
  async stop(): Promise<void> {
    this.stopHealthCheck();

    if (!this.state.process) {
      return;
    }

    log(LogMessages.stopping);

    // Try graceful shutdown first - direct fetch to avoid start() being called
    if (this.state.port) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PYTHON_SHUTDOWN_TIMEOUT_MS);
        await fetch(`http://127.0.0.1:${this.state.port}/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Wait for process to exit or kill it
    await new Promise<void>((resolve) => {
      const proc = this.state.process;
      if (!proc) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, PYTHON_KILL_TIMEOUT_MS);

      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill("SIGTERM");
    });

    this.state.process = null;
    this.state.port = null;
    this.state.ready = false;
  }

  /**
   * Make an HTTP request to the Python server
   */
  async request<T>(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
    timeout: number = XCOMET_DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    // Ensure server is started
    await this.start();

    if (!this.state.port) {
      throw new Error(PythonServerErrors.notRunning);
    }

    const url = `http://127.0.0.1:${this.state.port}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: response.statusText })) as { detail?: string };
        throw new Error(errorData.detail || `HTTP ${response.status}`);
      }

      return await response.json() as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(PythonServerErrors.requestTimeout);
      }
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ status: string; model_loaded: boolean; model_name: string }> {
    return this.request("/health", "GET", undefined, PYTHON_STATS_TIMEOUT_MS);
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
        log(LogMessages.healthCheckFailed(this.state.consecutiveFailures, PYTHON_HEALTH_CHECK_FAILURES_BEFORE_RESTART, error));

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
        this.state.process.kill("SIGTERM");
        this.state.process = null;
      }
      this.state.ready = false;
      this.state.port = null;
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
   * Get server port
   */
  getPort(): number | null {
    return this.state.port;
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
    evaluate_api_count: number;
    detect_errors_api_count: number;
    batch_api_count: number;
    total_pairs_evaluated: number;
    total_inference_time_ms: number;
    avg_inference_time_ms: number | null;
  }> {
    return this.request("/stats", "GET", undefined, PYTHON_STATS_TIMEOUT_MS);
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
