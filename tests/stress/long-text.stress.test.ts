/**
 * Stress test: long-form text evaluation
 *
 * Not part of the default `npm test` because xCOMET inference on long
 * inputs has unbounded CPU latency (can exceed 90s). Run manually with
 *   npm run test:stress
 *
 * Auto-skips when the Python `comet` package is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  checkPythonDeps,
  createServerLifecycle,
} from "../helpers/test-utils.js";

const hasPythonDeps = checkPythonDeps();

interface EvaluateResult {
  score: number;
  errors: unknown[];
  summary: string;
}

describe.skipIf(!hasPythonDeps)("Stress: long text evaluation", () => {
  const server = createServerLifecycle();

  beforeAll(async () => {
    await server.start();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it(
    "should evaluate ~900 character ja→en pair within 3 minutes",
    async () => {
      const longText = "これはテストです。".repeat(100); // ~900 chars
      const longTranslation = "This is a test. ".repeat(100);

      const result = await server.client.request<EvaluateResult>(
        "evaluate",
        { source: longText, translation: longTranslation },
        180_000,
      );

      expect(result).toHaveProperty("score");
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    },
    200_000,
  );
});
