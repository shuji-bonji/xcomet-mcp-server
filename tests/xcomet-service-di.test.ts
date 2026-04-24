/**
 * XCometService — DI / unit tests
 *
 * These tests exercise XCometService without spawning a Python process,
 * by injecting a mock implementation of IPythonServerManager. They verify:
 *
 *  - pairs / params are forwarded correctly to the manager
 *  - reference-required validation fires before any RPC call
 *  - empty batchEvaluate short-circuits without hitting the manager
 *  - batchEvaluate extends the base timeout proportionally to pair count
 */

import { describe, it, expect } from "vitest";
import { XCometService, type IPythonServerManager } from "../src/services/xcomet.js";
import type {
  EvaluateOutput,
  DetectErrorsOutput,
  BatchEvaluateOutput,
} from "../src/schemas/index.js";

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  timeout?: number;
}

function makeMockManager(
  responses: Partial<Record<string, unknown>> = {},
): IPythonServerManager & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async request<T>(
      method: string,
      params: Record<string, unknown>,
      timeout?: number,
    ): Promise<T> {
      calls.push({ method, params, timeout });
      const response = responses[method];
      if (response === undefined) {
        throw new Error(`mock: no response configured for method "${method}"`);
      }
      return response as T;
    },
    async healthCheck() {
      return { status: "ok", model_loaded: true, model_name: "mock-model" };
    },
    getPythonPath() {
      return "/mock/python";
    },
    getModel() {
      return "mock-model";
    },
  };
}

describe("XCometService (DI / unit)", () => {
  it("forwards evaluate parameters to the injected manager", async () => {
    const mockEvaluate: EvaluateOutput = {
      score: 0.87,
      errors: [],
      summary: "Good quality",
    };
    const mock = makeMockManager({ evaluate: mockEvaluate });
    const service = new XCometService({}, mock);

    const result = await service.evaluate(
      "非同期処理",
      "asynchronous processing",
      undefined,
      false,
    );

    expect(result).toEqual(mockEvaluate);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      method: "evaluate",
      params: {
        source: "非同期処理",
        translation: "asynchronous processing",
        reference: undefined,
        use_gpu: false,
      },
    });
    expect(mock.calls[0].timeout).toBeTypeOf("number");
  });

  it("rejects evaluate without reference for WMT models (before calling manager)", async () => {
    const mock = makeMockManager({});
    const service = new XCometService(
      { model: "Unbabel/wmt22-comet-da" },
      mock,
    );

    await expect(
      service.evaluate("hello", "こんにちは"),
    ).rejects.toThrow(/requires a reference translation/i);

    expect(mock.calls).toHaveLength(0);
  });

  it("forwards detectErrors parameters correctly", async () => {
    const mockDetect: DetectErrorsOutput = {
      total_errors: 0,
      errors_by_severity: { minor: 0, major: 0, critical: 0 },
      errors: [],
    };
    const mock = makeMockManager({ detect_errors: mockDetect });
    const service = new XCometService({}, mock);

    const result = await service.detectErrors(
      "Hello",
      "こんにちは",
      undefined,
      "major",
      false,
    );

    expect(result).toEqual(mockDetect);
    expect(mock.calls[0]).toMatchObject({
      method: "detect_errors",
      params: {
        source: "Hello",
        translation: "こんにちは",
        reference: undefined,
        min_severity: "major",
        use_gpu: false,
      },
    });
  });

  it("short-circuits batchEvaluate when pairs is empty (no RPC)", async () => {
    const mock = makeMockManager({});
    const service = new XCometService({}, mock);

    const result = await service.batchEvaluate([]);

    expect(result).toEqual({
      average_score: 0,
      total_pairs: 0,
      results: [],
      summary: "No pairs to evaluate.",
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("extends batch timeout proportionally to pair count", async () => {
    const mockBatch: BatchEvaluateOutput = {
      average_score: 0.9,
      total_pairs: 3,
      results: [],
      summary: "ok",
    };
    const mock = makeMockManager({ batch_evaluate: mockBatch });
    const service = new XCometService({ timeout: 10_000 }, mock);

    const pairs = [
      { source: "a", translation: "b" },
      { source: "c", translation: "d" },
      { source: "e", translation: "f" },
    ];

    await service.batchEvaluate(pairs, 8, false);

    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call.method).toBe("batch_evaluate");
    // base timeout (10_000ms) + 3 pairs * 5_000ms CPU = 25_000ms
    expect(call.timeout).toBe(10_000 + 3 * 5_000);
    expect(call.params).toMatchObject({ pairs, batch_size: 8, use_gpu: false });
  });

  it("validates batch reference requirement for WMT models before RPC", async () => {
    const mock = makeMockManager({});
    const service = new XCometService(
      { model: "Unbabel/wmt22-comet-da" },
      mock,
    );

    await expect(
      service.batchEvaluate([
        { source: "a", translation: "b", reference: "ref" },
        { source: "c", translation: "d" }, // missing reference
      ]),
    ).rejects.toThrow(/reference/i);

    expect(mock.calls).toHaveLength(0);
  });

  it("exposes python path and model from the injected manager", () => {
    const mock = makeMockManager({});
    const service = new XCometService({}, mock);

    expect(service.getPythonPath()).toBe("/mock/python");
    expect(service.getModel()).toBe("mock-model");
  });
});
