/**
 * Centralized constants for xCOMET MCP Server
 *
 * This file contains all configurable constants and magic numbers
 * to improve maintainability and make configuration changes easier.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load package.json to get version dynamically
 */
function loadPackageJson(): { name: string; version: string } {
  const possiblePaths = [
    join(__dirname, "..", "..", "package.json"),
    join(__dirname, "..", "..", "..", "package.json"),
    join(process.cwd(), "package.json"),
  ];

  for (const path of possiblePaths) {
    try {
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content);
    } catch {
      // Try next path
    }
  }

  // Fallback values if package.json cannot be read
  return { name: "xcomet-mcp-server", version: "0.0.0" };
}

const pkg = loadPackageJson();

// =============================================================================
// Server Metadata
// =============================================================================

/** Server name for MCP protocol */
export const SERVER_NAME = pkg.name;

/** Server version from package.json */
export const SERVER_VERSION = pkg.version;

// =============================================================================
// Python Server Configuration
// =============================================================================

/** Health check interval in milliseconds (30 seconds) */
export const PYTHON_HEALTH_CHECK_INTERVAL_MS = 30000;

/** Maximum number of automatic restarts */
export const PYTHON_MAX_RESTARTS = 3;

/** Number of consecutive health check failures before auto-restart */
export const PYTHON_HEALTH_CHECK_FAILURES_BEFORE_RESTART = 3;

/** Delay between restart attempts in milliseconds */
export const PYTHON_RESTART_DELAY_MS = 2000;

/** Timeout for Python server to start in milliseconds */
export const PYTHON_SERVER_START_TIMEOUT_MS = 30000;

/** Timeout for stats/health requests in milliseconds */
export const PYTHON_STATS_TIMEOUT_MS = 5000;

/** Timeout for force kill after SIGTERM in milliseconds */
export const PYTHON_KILL_TIMEOUT_MS = 5000;

/** Timeout for Python dependency check in milliseconds */
export const PYTHON_DEPENDENCY_CHECK_TIMEOUT_MS = 5000;

// =============================================================================
// xCOMET Service Configuration
// =============================================================================

/** Default timeout for xCOMET requests in milliseconds (5 minutes) */
export const XCOMET_DEFAULT_TIMEOUT_MS = 300000;

/** Per-pair processing time estimate for GPU in milliseconds */
export const XCOMET_GPU_PER_PAIR_TIME_MS = 1000;

/** Per-pair processing time estimate for CPU in milliseconds */
export const XCOMET_CPU_PER_PAIR_TIME_MS = 5000;

/** Default xCOMET model */
export const XCOMET_DEFAULT_MODEL = "Unbabel/XCOMET-XL";

/**
 * Models that require a reference translation for evaluation.
 * These are WMT (Conference on Machine Translation) models.
 */
export const REFERENCE_REQUIRED_MODELS = [
  "Unbabel/wmt22-comet-da",
  "Unbabel/wmt20-comet-da",
  "Unbabel/wmt21-comet-da",
] as const;

// =============================================================================
// Schema Constraints
// =============================================================================

/** Maximum text length for source/translation/reference */
export const MAX_TEXT_LENGTH = 10000;

/** Maximum number of pairs in batch evaluation */
export const MAX_BATCH_PAIRS = 500;

/** Minimum batch size for processing */
export const MIN_BATCH_SIZE = 1;

/** Maximum batch size for processing */
export const MAX_BATCH_SIZE = 64;

/** Default batch size for processing */
export const DEFAULT_BATCH_SIZE = 8;

// =============================================================================
// Python Path Detection
// =============================================================================

/** Homebrew Python paths to check (in order) */
export const HOMEBREW_PYTHON_PATHS = [
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
] as const;

/**
 * Required Python packages for the server.
 *
 * Only `comet` is needed since the server communicates over stdio
 * (no fastapi/uvicorn required).
 */
export const REQUIRED_PYTHON_PACKAGES = ["comet"] as const;

// =============================================================================
// Quality Thresholds (for display purposes)
// =============================================================================

/** Score threshold for "excellent" quality */
export const QUALITY_THRESHOLD_EXCELLENT = 0.9;

/** Score threshold for "good" quality */
export const QUALITY_THRESHOLD_GOOD = 0.7;

/** Score threshold for "fair" quality */
export const QUALITY_THRESHOLD_FAIR = 0.5;

/** Score threshold for "poor" quality */
export const QUALITY_THRESHOLD_POOR = 0.3;
