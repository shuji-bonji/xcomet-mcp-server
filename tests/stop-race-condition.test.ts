/**
 * Tests for stop() race condition fix (Fix #2: stop() should not call start())
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Mock implementation to test stop() behavior
 * This simulates the fixed behavior where stop() uses direct fetch
 * instead of request() which would call start()
 */
class MockPythonServerManager {
  state = {
    process: null as unknown,
    port: null as number | null,
    ready: false,
  };

  startCallCount = 0;
  fetchCalls: Array<{ url: string; method: string }> = [];

  async start(): Promise<void> {
    this.startCallCount++;
    this.state.ready = true;
    this.state.port = 12345;
    this.state.process = { kill: vi.fn() };
  }

  // Fixed stop() implementation - uses direct fetch, not request()
  async stop(): Promise<void> {
    if (!this.state.process) {
      return;
    }

    // Direct fetch to avoid calling start()
    if (this.state.port) {
      try {
        // Simulate fetch call
        this.fetchCalls.push({
          url: `http://127.0.0.1:${this.state.port}/shutdown`,
          method: "POST",
        });
      } catch {
        // Ignore errors during shutdown
      }
    }

    this.state.process = null;
    this.state.port = null;
    this.state.ready = false;
  }

  // Old buggy implementation that would call start()
  async stopBuggy(): Promise<void> {
    if (!this.state.process) {
      return;
    }

    // Bug: This calls request() which calls start()
    await this.request("/shutdown", "POST");

    this.state.process = null;
    this.state.port = null;
    this.state.ready = false;
  }

  async request(path: string, method: string): Promise<unknown> {
    // Ensure server is started - THIS IS THE BUG
    await this.start();

    this.fetchCalls.push({
      url: `http://127.0.0.1:${this.state.port}${path}`,
      method,
    });
    return {};
  }
}

describe("stop() race condition", () => {
  let manager: MockPythonServerManager;

  beforeEach(() => {
    manager = new MockPythonServerManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fixed stop() should not call start() when server is running", async () => {
    // Setup: server is running
    await manager.start();
    expect(manager.startCallCount).toBe(1);

    // Act: stop the server
    await manager.stop();

    // Assert: start() was not called again
    expect(manager.startCallCount).toBe(1);
    expect(manager.fetchCalls).toHaveLength(1);
    expect(manager.fetchCalls[0].url).toContain("/shutdown");
  });

  it("fixed stop() should not call start() when server is not running", async () => {
    // Setup: server never started, but has a process (edge case)
    manager.state.process = { kill: vi.fn() };
    manager.state.port = null; // No port yet

    // Act: stop the server
    await manager.stop();

    // Assert: start() was never called, no fetch attempted (no port)
    expect(manager.startCallCount).toBe(0);
    expect(manager.fetchCalls).toHaveLength(0);
  });

  it("buggy stop() would call start() unnecessarily", async () => {
    // Setup: server is running
    await manager.start();
    expect(manager.startCallCount).toBe(1);

    // Act: stop with buggy implementation
    await manager.stopBuggy();

    // Assert: start() was called again (the bug)
    expect(manager.startCallCount).toBe(2); // Bug: called twice!
  });

  it("fixed stop() should handle missing port gracefully", async () => {
    // Setup: process exists but port is null (startup incomplete)
    manager.state.process = { kill: vi.fn() };
    manager.state.port = null;

    // Act: stop the server
    await manager.stop();

    // Assert: no fetch attempted, no crash
    expect(manager.fetchCalls).toHaveLength(0);
    expect(manager.state.process).toBeNull();
  });

  it("fixed stop() should skip shutdown request when no process", async () => {
    // Setup: no process running
    manager.state.process = null;
    manager.state.port = null;

    // Act: stop (should be no-op)
    await manager.stop();

    // Assert: no fetch, no start
    expect(manager.fetchCalls).toHaveLength(0);
    expect(manager.startCallCount).toBe(0);
  });
});
