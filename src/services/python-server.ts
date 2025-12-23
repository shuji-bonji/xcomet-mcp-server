/**
 * Python Server Manager
 * Manages a persistent Python FastAPI server for xCOMET inference.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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
function detectPythonPath(): string {
  // 1. Check environment variable
  const envPath = process.env.XCOMET_PYTHON_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const home = homedir();

  // 2. Check pyenv versions
  const pyenvDir = join(home, ".pyenv", "versions");
  if (existsSync(pyenvDir)) {
    try {
      const versions = require("fs")
        .readdirSync(pyenvDir)
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
            execSync(`${pythonPath} -c "import comet; import fastapi"`, {
              timeout: 5000,
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

  // 3. Check Homebrew
  const brewPaths = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
  for (const path of brewPaths) {
    if (existsSync(path)) {
      try {
        execSync(`${path} -c "import comet; import fastapi"`, {
          timeout: 5000,
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
      model: config.model || process.env.XCOMET_MODEL || "Unbabel/XCOMET-XL",
      maxRetries: config.maxRetries ?? 3,
      healthCheckInterval: config.healthCheckInterval ?? 30000,
      maxRestarts: config.maxRestarts ?? 3,
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

    throw new Error("Python server script not found");
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

    console.error(`[xcomet] Starting Python server with ${this.config.pythonPath}`);
    console.error(`[xcomet] Model: ${this.config.model}`);

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

    // Handle stdout to get the port
    let portReceived = false;
    const portPromise = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!portReceived) {
          reject(new Error("Timeout waiting for Python server to start"));
        }
      }, 30000);

      proc.stdout?.on("data", (data: Buffer) => {
        const output = data.toString().trim();
        try {
          const json = JSON.parse(output);
          if (json.port) {
            portReceived = true;
            clearTimeout(timeout);
            resolve(json.port);
          }
        } catch {
          // Not JSON, ignore
          console.error(`[xcomet-python] ${output}`);
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.on("exit", (code) => {
        if (!portReceived) {
          clearTimeout(timeout);
          reject(new Error(`Python server exited with code ${code}`));
        }
      });
    });

    // Log stderr
    proc.stderr?.on("data", (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[xcomet-python] ${output}`);
      }
    });

    try {
      const port = await portPromise;
      this.state.port = port;
      this.state.ready = true;
      this.state.starting = false;
      console.error(`[xcomet] Python server started on port ${port}`);

      // Start health check
      this.startHealthCheck();

      // Handle process exit
      proc.on("exit", (code) => {
        console.error(`[xcomet] Python server exited with code ${code}`);
        this.state.ready = false;
        this.state.process = null;
        this.state.port = null;
        this.stopHealthCheck();
      });
    } catch (error) {
      this.state.starting = false;
      this.state.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Stop the Python server
   */
  async stop(): Promise<void> {
    this.stopHealthCheck();

    if (!this.state.process) {
      return;
    }

    console.error("[xcomet] Stopping Python server...");

    // Try graceful shutdown first
    try {
      await this.request("/shutdown", "POST", {}, 2000);
    } catch {
      // Ignore errors during shutdown
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
      }, 5000);

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
    timeout: number = 300000
  ): Promise<T> {
    // Ensure server is started
    await this.start();

    if (!this.state.port) {
      throw new Error("Python server not running");
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
        throw new Error("Request timeout");
      }
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ status: string; model_loaded: boolean; model_name: string }> {
    return this.request("/health", "GET", undefined, 5000);
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
        console.error(`[xcomet] Health check failed (${this.state.consecutiveFailures}/3):`, error);

        // Auto-restart after 3 consecutive failures
        if (this.state.consecutiveFailures >= 3) {
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
      console.error(`[xcomet] Max restarts (${this.config.maxRestarts}) reached, giving up`);
      return;
    }

    this.isRestarting = true;
    this.state.restartCount++;
    console.error(`[xcomet] Attempting restart (${this.state.restartCount}/${this.config.maxRestarts})...`);

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
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Start a new server
      await this._start();
      console.error("[xcomet] Server restarted successfully");
    } catch (error) {
      console.error("[xcomet] Restart failed:", error);
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
    evaluation_count: number;
    batch_count: number;
    total_pairs_evaluated: number;
    total_inference_time_ms: number;
    avg_inference_time_ms: number | null;
  }> {
    return this.request("/stats", "GET", undefined, 5000);
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
