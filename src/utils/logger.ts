/**
 * Centralized logger for the xCOMET MCP server.
 *
 * MCP servers communicate over stdio: stdout is reserved for the protocol,
 * so all human-facing log output MUST go to stderr. This module is the
 * single chokepoint for that rule — never call `console.log` or
 * `process.stdout.write` from elsewhere in the codebase.
 *
 * `debug` only emits when `XCOMET_DEBUG=true`; `info` / `warn` / `error`
 * always emit. All four go to stderr.
 */

const DEBUG = process.env.XCOMET_DEBUG === "true";

function write(message: string): void {
  // Use console.error so that lint's no-console rule (which allows
  // "error"/"warn") stays in effect for any direct callers that creep in.
  console.error(message);
}

export const logger = {
  /** Emitted only when XCOMET_DEBUG=true */
  debug(message: string): void {
    if (DEBUG) write(message);
  },

  /** Always emitted to stderr */
  info(message: string): void {
    write(message);
  },

  /** Always emitted to stderr */
  warn(message: string): void {
    write(message);
  },

  /** Always emitted to stderr */
  error(message: string): void {
    write(message);
  },

  /** Whether debug logging is currently enabled (read at module load). */
  get isDebugEnabled(): boolean {
    return DEBUG;
  },
};
