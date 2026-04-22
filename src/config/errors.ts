/**
 * Centralized error messages for xCOMET MCP Server
 *
 * This module provides consistent error messages throughout the application.
 * Centralizing error messages improves maintainability and makes it easier
 * to support internationalization in the future.
 */

/**
 * Error messages for Python server operations
 */
export const PythonServerErrors = {
  /** Timeout waiting for Python server to start */
  startupTimeout: "Timeout waiting for Python server to start",

  /** Python server script not found */
  scriptNotFound: "Python server script not found",

  /** Python server not running */
  notRunning: "Python server not running",

  /** Request timeout */
  requestTimeout: "Request timeout",

  /** Server exited with code */
  exitedWithCode: (code: number | null) =>
    `Python server exited with code ${code}`,

  /** Max restarts reached */
  maxRestartsReached: (maxRestarts: number) =>
    `Max restarts (${maxRestarts}) reached, giving up`,
} as const;

/**
 * Error messages for xCOMET service operations
 */
export const XCometServiceErrors = {
  /** Reference required for model */
  referenceRequired: (model: string) =>
    `Model "${model}" requires a reference translation. ` +
    `Please provide the 'reference' parameter, or use an XCOMET model (e.g., Unbabel/XCOMET-XL) for referenceless evaluation.`,

  /** Batch reference required for model */
  batchReferenceRequired: (model: string, missingCount: number, totalCount: number) =>
    `Model "${model}" requires reference translations. ` +
    `${missingCount} of ${totalCount} pairs are missing 'reference'. ` +
    `Please provide references for all pairs, or use an XCOMET model (e.g., Unbabel/XCOMET-XL) for referenceless evaluation.`,
} as const;

/**
 * Error messages for availability check
 */
export const AvailabilityErrors = {
  /** Python not found */
  pythonNotFound: (pythonPath: string) =>
    `Python not found at "${pythonPath}". Please install Python 3.8+ and dependencies:\n` +
    `  1. Install Python: https://www.python.org/downloads/\n` +
    `  2. Install xCOMET: pip install 'unbabel-comet>=2.2.0'\n` +
    `  3. Set XCOMET_PYTHON_PATH if using pyenv/venv`,

  /** Missing Python dependencies */
  missingDependencies: (pythonPath: string) =>
    `Missing Python dependencies. Run:\n` +
    `  ${pythonPath} -m pip install 'unbabel-comet>=2.2.0'`,

  /** General Python server failure */
  serverFailed: (errorMessage: string, pythonPath: string) =>
    `Python server failed: ${errorMessage}\n` +
    `Python path: ${pythonPath}\n` +
    `Tip: Set XCOMET_PYTHON_PATH to specify Python with dependencies installed`,
} as const;

/**
 * Success/info messages
 */
export const InfoMessages = {
  /** xCOMET available with model */
  available: (modelName: string) =>
    `xCOMET is available (model: ${modelName})`,

  /** xCOMET server running, model will load on first request */
  serverRunning: "xCOMET server is running, model will load on first request",
} as const;

/**
 * Log messages for Python server operations
 */
export const LogMessages = {
  /** Starting Python server */
  starting: (pythonPath: string) =>
    `[xcomet] Starting Python server with ${pythonPath}`,

  /** Server is ready */
  ready: () => `[xcomet] Python server is ready (stdio)`,

  /** Server exited */
  exited: (code: number | null) =>
    `[xcomet] Python server exited with code ${code}`,

  /** Stopping server */
  stopping: "[xcomet] Stopping Python server...",

  /** Health check failed */
  healthCheckFailed: (failures: number, maxFailures: number, error: unknown) =>
    `[xcomet] Health check failed (${failures}/${maxFailures}): ${error}`,

  /** Attempting restart */
  attemptingRestart: (count: number, maxRestarts: number) =>
    `[xcomet] Attempting restart (${count}/${maxRestarts})...`,

  /** Restart successful */
  restartSuccessful: "[xcomet] Server restarted successfully",

  /** Restart failed */
  restartFailed: (error: unknown) =>
    `[xcomet] Restart failed: ${error}`,

  /** Received shutdown signal */
  shutdownSignal: (signal: string) =>
    `[xcomet] Received ${signal}, shutting down...`,

  /** Shutdown complete */
  shutdownComplete: "[xcomet] Shutdown complete",

  /** Shutdown error */
  shutdownError: (error: unknown) =>
    `[xcomet] Shutdown error: ${error}`,
} as const;
