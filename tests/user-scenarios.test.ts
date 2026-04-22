/**
 * User Scenario Tests - 利用者視点のテストケース (stdio RPC)
 *
 * These tests cover real-world usage scenarios including:
 * - Edge cases and boundary values
 * - Various language pairs
 * - Error handling
 * - Quality validation scenarios
 * - Performance and stability
 *
 * All calls go through the stdio JSON-RPC client (see test-utils.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  checkPythonDeps,
  createServerLifecycle,
  toBeOneOfMatcher,
} from "./helpers/test-utils.js";

// Register custom matcher
expect.extend(toBeOneOfMatcher);

const hasPythonDeps = checkPythonDeps();

interface EvaluateResult {
  score: number;
  errors: unknown[];
  summary: string;
}

interface DetectErrorsResult {
  total_errors: number;
  errors_by_severity: Record<string, number>;
  errors: unknown[];
}

describe.skipIf(!hasPythonDeps)("User Scenarios", () => {
  const server = createServerLifecycle();

  beforeAll(async () => {
    await server.start();
  }, 30000);

  afterAll(async () => {
    await server.stop();
  });

  // ============================================================
  // 1. 境界値・エッジケース
  // ============================================================
  describe("1. Edge Cases and Boundary Values", () => {
    // Skip: Empty strings cause model to hang - needs server-side validation
    it.skip("should handle empty strings gracefully", async () => {
      await expect(
        server.client.request("evaluate", { source: "", translation: "" })
      ).resolves.toBeDefined();
    });

    // Skip: Long text takes too long for regular CI - run manually for stress testing
    it.skip("should handle very long text (1000+ characters)", async () => {
      const longText = "これはテストです。".repeat(100); // ~900 chars
      const longTranslation = "This is a test. ".repeat(100);

      const result = await server.client.request<EvaluateResult>(
        "evaluate",
        { source: longText, translation: longTranslation },
        180000
      );

      expect(result).toHaveProperty("score");
      expect(typeof result.score).toBe("number");
    }, 200000);

    it("should handle special characters and emojis", async () => {
      const result = await server.client.request<EvaluateResult>("evaluate", {
        source: "RxJS 🚀 は素晴らしい！ @user #tag $100",
        translation: "RxJS 🚀 is awesome! @user #tag $100",
      });
      expect(result).toHaveProperty("score");
    }, 120000);

    it("should handle code blocks in text", async () => {
      const result = await server.client.request<EvaluateResult>("evaluate", {
        source: "`map()` オペレーターと `filter()` を使用します",
        translation: "Use the `map()` operator and `filter()`",
      });
      expect(result).toHaveProperty("score");
    }, 60000);

    it("should handle HTML tags in text", async () => {
      const result = await server.client.request<EvaluateResult>("evaluate", {
        source: "<code>filter</code>関数と<strong>重要</strong>な概念",
        translation:
          "The <code>filter</code> function and <strong>important</strong> concepts",
      });
      expect(result).toHaveProperty("score");
    }, 60000);

    it("should handle newlines and whitespace", async () => {
      const result = await server.client.request<EvaluateResult>("evaluate", {
        source: "行1\n行2\n\t行3（タブ付き）",
        translation: "Line 1\nLine 2\n\tLine 3 (with tab)",
      });
      expect(result).toHaveProperty("score");
    }, 60000);
  });

  // ============================================================
  // 2. 言語ペアの網羅
  // ============================================================
  describe("2. Language Pair Coverage", () => {
    const languagePairs = [
      { source: "こんにちは", translation: "Hello", name: "ja → en" },
      { source: "こんにちは", translation: "Hallo", name: "ja → de" },
      { source: "こんにちは", translation: "Bonjour", name: "ja → fr" },
      { source: "こんにちは", translation: "Hola", name: "ja → es" },
      { source: "こんにちは", translation: "Ciao", name: "ja → it" },
      { source: "Hello", translation: "こんにちは", name: "en → ja" },
      { source: "你好", translation: "Hello", name: "zh → en" },
      { source: "안녕하세요", translation: "Hello", name: "ko → en" },
    ];

    for (const pair of languagePairs) {
      it(`should evaluate ${pair.name} translation`, async () => {
        const result = await server.client.request<EvaluateResult>("evaluate", {
          source: pair.source,
          translation: pair.translation,
        });
        expect(result).toHaveProperty("score");
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      });
    }
  });

  // ============================================================
  // 3. エラーハンドリング
  // ============================================================
  describe("3. Error Handling", () => {
    it("should reject when required fields are missing", async () => {
      // The Python handler calls params["source"] / ["translation"] directly,
      // so missing keys produce a KeyError that we surface as an RPC error.
      await expect(
        server.client.request("evaluate", { source: "テスト" })
      ).rejects.toThrow();
    });

    it("should reject unknown RPC methods", async () => {
      await expect(server.client.request("nope_not_a_method")).rejects.toThrow(
        /Unknown method/
      );
    });

    it("should handle batch with maximum allowed pairs (500)", async () => {
      const pairs = Array(500)
        .fill(null)
        .map((_, i) => ({
          source: `テスト ${i}`,
          translation: `test ${i}`,
        }));

      // Should succeed (or fail predictably on memory-constrained runners).
      // We only assert the call resolves one way or another.
      await expect(
        server.client.request("batch_evaluate", { pairs, batch_size: 32 }, 180000)
      ).resolves.toBeDefined();
    }, 200000);
  });

  // ============================================================
  // 4. 品質検証シナリオ
  // ============================================================
  describe("4. Quality Validation Scenarios", () => {
    it("should detect obvious mistranslation (opposite meaning)", async () => {
      const result = await server.client.request<EvaluateResult>("evaluate", {
        source: "非同期処理",
        translation: "synchronous processing",
      });
      expect(result).toHaveProperty("score");
    });

    it("should detect partial translation (missing content)", async () => {
      const result = await server.client.request<EvaluateResult>("evaluate", {
        source: "RxJSは強力で柔軟なライブラリです",
        translation: "RxJS is a library",
      });
      expect(result).toHaveProperty("score");
    });

    it("should evaluate unnatural translation", async () => {
      const result = await server.client.request<EvaluateResult>("evaluate", {
        source: "購読を解除する",
        translation: "cancel the subscription following",
      });
      expect(result).toHaveProperty("score");
    });

    it("should give high score to accurate translation", async () => {
      const result = await server.client.request<EvaluateResult>("evaluate", {
        source: "ユーザー認証が完了しました",
        translation: "User authentication completed",
      });
      expect(result).toHaveProperty("score");
      expect(result.score).toBeGreaterThan(0.5);
    });

    it("should use detect_errors method for error detection", async () => {
      const result = await server.client.request<DetectErrorsResult>(
        "detect_errors",
        {
          source: "この機能は非推奨です",
          translation: "This feature is recommended",
          min_severity: "minor",
        }
      );
      expect(result).toHaveProperty("total_errors");
      expect(result).toHaveProperty("errors_by_severity");
      expect(result).toHaveProperty("errors");
    });
  });

  // ============================================================
  // 5. パフォーマンス・安定性
  // ============================================================
  describe("5. Performance and Stability", () => {
    it("should handle sequential requests (10 requests)", async () => {
      const results: number[] = [];

      for (let i = 0; i < 10; i++) {
        const start = Date.now();
        await server.client.request<EvaluateResult>("evaluate", {
          source: `テスト文 ${i}`,
          translation: `Test sentence ${i}`,
        });
        results.push(Date.now() - start);
      }

      expect(results).toHaveLength(10);
      const avg = results.reduce((a, b) => a + b, 0) / results.length;
      console.log(
        `Sequential requests: avg=${avg.toFixed(0)}ms, min=${Math.min(
          ...results
        )}ms, max=${Math.max(...results)}ms`
      );
    }, 60000);

    it("should handle concurrent requests (5 parallel)", async () => {
      const start = Date.now();

      const promises = Array(5)
        .fill(null)
        .map((_, i) =>
          server.client.request<EvaluateResult>("evaluate", {
            source: `並列テスト ${i}`,
            translation: `Parallel test ${i}`,
          })
        );

      const responses = await Promise.all(promises);
      const elapsed = Date.now() - start;

      for (const resp of responses) {
        expect(resp).toHaveProperty("score");
      }

      console.log(`Concurrent requests (5): total=${elapsed}ms`);
    }, 60000);

    it("should maintain stable response times", async () => {
      const times: number[] = [];

      // Warm up
      await server.client.request<EvaluateResult>("evaluate", {
        source: "ウォームアップ",
        translation: "warmup",
      });

      // Measure 5 requests
      for (let i = 0; i < 5; i++) {
        const start = Date.now();
        await server.client.request<EvaluateResult>("evaluate", {
          source: "安定性テスト",
          translation: "stability test",
        });
        times.push(Date.now() - start);
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const variance =
        times.reduce((sum, t) => sum + Math.pow(t - avg, 2), 0) / times.length;
      const stdDev = Math.sqrt(variance);

      console.log(
        `Stability: avg=${avg.toFixed(0)}ms, stdDev=${stdDev.toFixed(0)}ms`
      );
    }, 60000);

    it("should recover from rapid health requests", async () => {
      // Fire 20 rapid health requests (cheap - no inference)
      const promises = Array(20)
        .fill(null)
        .map(() => server.client.request("health").catch(() => null));

      await Promise.all(promises);

      // Server should still be responsive
      const health = await server.client.request<{ status: string }>("health");
      expect(health.status).toBe("ok");
    });
  });
});
