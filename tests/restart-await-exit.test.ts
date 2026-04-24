/**
 * Regression test for the attemptRestart() / terminateProcess() invariant:
 *
 *   When restarting the Python worker, the previous process MUST have
 *   exited before a new one is spawned.
 *
 * Background: A previous implementation called `proc.kill("SIGTERM")` and
 * immediately moved on to spawning a fresh process. xCOMET is a multi-GB
 * model — for a brief window we'd hold two workers in memory, each loading
 * the model. This test pins down the "wait for exit before respawn" rule
 * using a mock process that records its lifecycle ordering.
 *
 * Pure unit test — no Python required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

const PYTHON_KILL_TIMEOUT_MS = 50; // tiny timeout for tests
const PYTHON_RESTART_DELAY_MS = 5;

interface MockProc extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  stdin: { end: () => void; ended: boolean } | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  /** Test helper: simulate the process exiting */
  simulateExit(code: number, signal?: NodeJS.Signals): void;
}

function createMockProc(opts: { exitOnSigterm?: boolean } = {}): MockProc {
  const ee = new EventEmitter() as MockProc;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.killed = false;
  ee.stdin = {
    ended: false,
    end() {
      this.ended = true;
    },
  };
  ee.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (ee.exitCode !== null) return false;
    ee.killed = true;
    if (signal === "SIGKILL") {
      // SIGKILL is unblockable
      ee.simulateExit(137, signal);
    } else if (opts.exitOnSigterm) {
      // Cooperative process: exits on SIGTERM
      setImmediate(() => ee.simulateExit(0, signal));
    }
    return true;
  };
  ee.simulateExit = (code: number, signal?: NodeJS.Signals) => {
    if (ee.exitCode !== null) return;
    ee.exitCode = code;
    ee.signalCode = signal ?? null;
    ee.emit("exit", code, signal ?? null);
  };
  return ee;
}

/**
 * Minimal extract of the terminateProcess + attemptRestart logic. Mirrors
 * src/services/python-server.ts but simplified for testability.
 */
class MockManager {
  events: string[] = []; // ordered lifecycle events
  process: MockProc | null = null;

  async terminateProcess(proc: MockProc): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      this.events.push("terminate:already-exited");
      return;
    }
    try {
      proc.stdin?.end();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, PYTHON_KILL_TIMEOUT_MS);

      proc.once("exit", () => {
        clearTimeout(timer);
        this.events.push("terminate:exit-observed");
        resolve();
      });

      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    });
  }

  async attemptRestart(spawnNew: () => MockProc): Promise<void> {
    const old = this.process;
    if (old) {
      this.events.push("restart:terminate-old:start");
      await this.terminateProcess(old);
      this.events.push("restart:terminate-old:done");
      this.process = null;
    }
    await new Promise((resolve) => setTimeout(resolve, PYTHON_RESTART_DELAY_MS));
    this.events.push("restart:spawn-new");
    this.process = spawnNew();
  }
}

describe("attemptRestart() — terminateProcess invariants", () => {
  let mgr: MockManager;

  beforeEach(() => {
    mgr = new MockManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for the old process to exit before spawning a new one (cooperative SIGTERM)", async () => {
    const oldProc = createMockProc({ exitOnSigterm: true });
    mgr.process = oldProc;

    const newProc = createMockProc();
    await mgr.attemptRestart(() => newProc);

    // Critical ordering: old process must be observed exiting BEFORE the
    // new one is spawned.
    const terminateDoneIdx = mgr.events.indexOf("restart:terminate-old:done");
    const spawnIdx = mgr.events.indexOf("restart:spawn-new");
    expect(terminateDoneIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThan(terminateDoneIdx);
    expect(oldProc.killed).toBe(true);
    expect(oldProc.exitCode).toBe(0);
  });

  it("falls back to SIGKILL when the process ignores SIGTERM", async () => {
    const oldProc = createMockProc({ exitOnSigterm: false });
    mgr.process = oldProc;

    const newProc = createMockProc();
    await mgr.attemptRestart(() => newProc);

    // SIGTERM was sent first, then SIGKILL after the timeout
    expect(oldProc.signalCode).toBe("SIGKILL");
    expect(oldProc.exitCode).toBe(137);
    // Spawn happened only after exit was observed
    const exitObservedIdx = mgr.events.indexOf("terminate:exit-observed");
    const spawnIdx = mgr.events.indexOf("restart:spawn-new");
    expect(spawnIdx).toBeGreaterThan(exitObservedIdx);
  });

  it("does not double-await an already-exited process", async () => {
    const oldProc = createMockProc();
    oldProc.simulateExit(0); // already gone
    mgr.process = oldProc;

    const newProc = createMockProc();
    await mgr.attemptRestart(() => newProc);

    expect(mgr.events).toContain("terminate:already-exited");
    // No SIGTERM/SIGKILL was sent because we short-circuit
    expect(oldProc.killed).toBe(false);
  });
});
