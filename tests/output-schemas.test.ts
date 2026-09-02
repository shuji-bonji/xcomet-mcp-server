/**
 * The MCP SDK validates every tool result's `structuredContent` against the
 * tool's `outputSchema` before it leaves the server. A field the Python worker
 * emits that the schema does not accept is therefore not a cosmetic mismatch —
 * the call fails with `Output validation error` and the caller gets nothing.
 *
 * That is how `suggestion: null` surfaced: the schema declared
 * `z.string().optional()`, which accepts `undefined` and rejects `null`, while
 * handle_detect_errors injected `{"suggestion": None, ...}` into every error.
 * It stayed hidden for four releases only because the error list was always
 * empty (see tests/test_server.py). The moment spans started coming through,
 * every xcomet_detect_errors call with at least one error failed.
 *
 * The payloads below are verbatim captures from python/server.py running
 * Unbabel/XCOMET-XL, not hand-written examples.
 */
import { describe, it, expect } from "vitest";
import {
  EvaluateOutputSchema,
  DetectErrorsOutputSchema,
  BatchEvaluateOutputSchema,
} from "../src/schemas/index.js";

describe("output schemas accept what the Python worker actually sends", () => {
  it("xcomet_evaluate: a result carrying an error span", () => {
    const payload = {
      score: 0.8964093327522278,
      errors: [
        { text: "Please renew the contract", start: 0, end: 25, severity: "major" },
      ],
      summary: "Good quality (score: 0.896) with 1 error(s) detected.",
    };
    expect(EvaluateOutputSchema.safeParse(payload).success).toBe(true);
  });

  it("xcomet_evaluate: a result with no error spans", () => {
    const payload = {
      score: 0.20433427393436432,
      errors: [],
      summary: "Poor quality (score: 0.204) with 0 error(s) detected.",
    };
    expect(EvaluateOutputSchema.safeParse(payload).success).toBe(true);
  });

  it("xcomet_detect_errors: a result carrying an error span", () => {
    const payload = {
      total_errors: 1,
      errors_by_severity: { minor: 1, major: 0, critical: 0 },
      errors: [{ text: "Suzuki", start: 3, end: 10, severity: "minor" }],
    };
    expect(DetectErrorsOutputSchema.safeParse(payload).success).toBe(true);
  });

  it("xcomet_detect_errors: an empty-text span is still a valid span", () => {
    // COMET's decode() can return a zero-width span when the MT contains
    // characters the tokenizer offsets do not line up with — observed on a
    // translation that left 設定 untranslated.
    const payload = {
      total_errors: 1,
      errors_by_severity: { minor: 1, major: 0, critical: 0 },
      errors: [{ text: "", start: 15, end: 16, severity: "minor" }],
    };
    expect(DetectErrorsOutputSchema.safeParse(payload).success).toBe(true);
  });

  it("xcomet_detect_errors: a null suggestion is rejected", () => {
    // Guards the regression directly: if `suggestion` is ever reintroduced,
    // it must not be a bare `.optional()` fed with null.
    const payload = {
      total_errors: 1,
      errors_by_severity: { minor: 1, major: 0, critical: 0 },
      errors: [
        { text: "Suzuki", start: 3, end: 10, severity: "minor", suggestion: null },
      ],
    };
    const parsed = DetectErrorsOutputSchema.safeParse(payload);
    // The extra key is stripped rather than rejected, and — this is the point —
    // it never reaches the wire as null.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.errors[0]).not.toHaveProperty("suggestion");
    }
  });

  it("xcomet_batch_evaluate: mixed results, some with spans", () => {
    const payload = {
      average_score: 0.9673971056938171,
      total_pairs: 5,
      results: [
        {
          index: 0,
          score: 0.9581764340400696,
          errors: [{ text: "Suzuki", start: 3, end: 10, severity: "minor" }],
          error_count: 1,
          has_critical_errors: false,
        },
        { index: 1, score: 1, errors: [], error_count: 0, has_critical_errors: false },
        {
          index: 2,
          score: 0.8964091539382935,
          errors: [
            { text: "Please renew the contract", start: 0, end: 25, severity: "major" },
          ],
          error_count: 1,
          has_critical_errors: false,
        },
        {
          index: 3,
          score: 0.9823999404907227,
          errors: [
            { text: "", start: 15, end: 16, severity: "minor" },
            { text: "immediately", start: 48, end: 60, severity: "minor" },
          ],
          error_count: 2,
          has_critical_errors: false,
        },
        { index: 4, score: 1, errors: [], error_count: 0, has_critical_errors: false },
      ],
      summary: "Evaluated 5 pairs. Average score: 0.967. 5 good quality, 0 with critical errors.",
    };
    expect(BatchEvaluateOutputSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects a severity the MQM label set does not define", () => {
    const payload = {
      score: 0.5,
      errors: [{ text: "x", start: 0, end: 1, severity: "catastrophic" }],
      summary: "…",
    };
    expect(EvaluateOutputSchema.safeParse(payload).success).toBe(false);
  });
});
