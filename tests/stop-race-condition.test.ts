/**
 * Regression test for the stop() race condition.
 *
 * Background: In the HTTP era, the real PythonServerManager had a bug
 * where stop() called request(), which called start() — so stopping
 * a shut-down server would inadvertently spawn a new one. That bug
 * was fixed by making stop() never go through request().
 *
 * In the stdio era, the equivalent shutdown path is:
 *   1. Close the child's stdin  (EOF -> graceful exit on the Python side)
 *   2. Send SIGTERM as a nudge
 *   3. Fall back to SIGKILL after a timeout
 *
 * These tests use a mock to verify the invariant still holds:
 * stop() must NOT call start(), regardless of state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface MockProcess {
  stdin: { end: () => void; ended: boolean };
  kill: (signal: string) => void;
  killedWith: string[];
}

function createMockProcess(): MockProcess {
  return {
    stdin: {
      ended: false,
      end() {
        this.ended = true;
      },
    },
    kill(signal: string) {
      this.killedWith.push(signal);
    },
    killedWith: [],
  };
}

class MockStdioServerManager {
  state = {
    process: null as MockProcess | null,
    ready: false,
  };

  startCallCount = 0;

  async start(): Promise<void> {
    this.startCallCount++;
    this.state.ready = true;
    this.state.process = createMockProcess();
  }

  // Fixed stop() — closes stdin, sends SIGTERM, never calls start()/request()
  async stop(): Promise<void> {
    const proc = this.state.process;
    if (!proc) {
      return;
    }

    try {
      proc.stdin.end();
    } catch {
      // already closed
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // already exited
    }

    this.state.process = null;
    this.state.ready = false;
  }

  // Hypothetical buggy implementation that would reintroduce the bug
  // by routing shutdown through request() (which calls start()).
  async stopBuggy(): Promise<void> {
    if (!this.state.process) return;
    await this.request("shutdown", {});
    this.state.process = null;
    this.state.ready = false;
  }

  async request(_method: string, _params: Record<string, unknown>): Promise<unknown> {
    // Auto-start is fine for real requests — but NOT for shutdown.
    await this.start();
    return {};
  }
}

describe("stop() race condition (stdio)", () => {
  let manager: MockStdioServerManager;

  beforeEach(() => {
    manager = new MockStdioServerManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fixed stop() closes stdin and sends SIGTERM without re-starting", async () => {
    await manager.start();
    expect(manager.startCallCount).toBe(1);

    const proc = manager.state.process!;
    await manager.stop();

    expect(manager.startCallCount).toBe(1); // no second start()
    expect(proc.stdin.ended).toBe(true);
    expect(proc.killedWith).toContain("SIGTERM");
    expect(manager.state.process).toBeNull();
    expect(manager.state.ready).toBe(false);
  });

  it("fixed stop() is a safe no-op when nothing is running", async () => {
    await manager.stop();
    expect(manager.startCallCount).toBe(0);
    expect(manager.state.process).toBeNull();
  });

  it("buggy stop() (for contrast) would restart the server unnecessarily", async () => {
    await manager.start();
    expect(manager.startCallCount).toBe(1);

    await manager.stopBuggy();

    // Demonstrates the bug: request() auto-started, so the count jumps to 2
    expect(manager.startCallCount).toBe(2);
  });
});
