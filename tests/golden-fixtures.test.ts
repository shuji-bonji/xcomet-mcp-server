/**
 * Golden fixtures regression test
 *
 * Runs every case in `tests/fixtures/golden.json` against a live Python
 * xCOMET worker and asserts the returned score falls inside the declared
 * `[score_min, score_max]` range.
 *
 * xCOMET output is not bitwise deterministic across hardware / library
 * versions, so we use generous range checks (not equality) as a regression
 * guard. Ranges are chosen wide enough to be stable but tight enough to
 * catch model/protocol drift.
 *
 * This suite is skipped when Python / `comet` is not available on the
 * test machine.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  checkPythonDeps,
  createServerLifecycle,
  RPC_REQUEST_TIMEOUT_MS,
} from "./helpers/test-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface GoldenCase {
  id: string;
  quality: "good" | "fair" | "poor";
  description: string;
  source: string;
  translation: string;
  reference?: string;
  source_lang?: string;
  target_lang?: string;
  score_min: number;
  score_max: number;
}

interface GoldenFile {
  version: string;
  model: string;
  description: string;
  cases: GoldenCase[];
}

interface EvaluateResult {
  score: number;
  errors: unknown[];
  summary: string;
}

function loadGoldenFixtures(): GoldenFile {
  const path = join(__dirname, "fixtures", "golden.json");
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as GoldenFile;
}

const fixtures = loadGoldenFixtures();
const hasPythonDeps = checkPythonDeps();

describe.skipIf(!hasPythonDeps)("Golden fixtures regression (Python required)", () => {
  const lifecycle = createServerLifecycle();

  beforeAll(async () => {
    await lifecycle.start();
  }, 60_000);

  afterAll(async () => {
    await lifecycle.stop();
  });

  it("loaded 20 fixtures", () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(20);
  });

  it("every fixture has a valid score range", () => {
    for (const c of fixtures.cases) {
      expect(c.score_min, `${c.id} min`).toBeGreaterThanOrEqual(0);
      expect(c.score_max, `${c.id} max`).toBeLessThanOrEqual(1.01);
      expect(c.score_min, `${c.id} order`).toBeLessThan(c.score_max);
    }
  });

  it("every fixture id is unique", () => {
    const ids = fixtures.cases.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  // Parameterized: one `it` per case — easier to diagnose failures.
  for (const c of fixtures.cases) {
    it(
      `[${c.quality}] ${c.id} — score within [${c.score_min}, ${c.score_max}]`,
      async () => {
        const result = await lifecycle.client.request<EvaluateResult>(
          "evaluate",
          {
            source: c.source,
            translation: c.translation,
            reference: c.reference,
            use_gpu: false,
          },
          RPC_REQUEST_TIMEOUT_MS,
        );

        expect(result.score, `score for ${c.id}`).toBeGreaterThanOrEqual(c.score_min);
        expect(result.score, `score for ${c.id}`).toBeLessThanOrEqual(c.score_max);
      },
      RPC_REQUEST_TIMEOUT_MS + 30_000,
    );
  }
});

// Non-Python meta tests — always run, even without comet.
describe("Golden fixtures (metadata)", () => {
  it("fixture file parses", () => {
    expect(fixtures.version).toBe("1.0");
    expect(fixtures.model).toMatch(/XCOMET/i);
  });

  it("contains at least 20 cases", () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(20);
  });

  it("every case has required fields", () => {
    for (const c of fixtures.cases) {
      expect(c.id).toBeTypeOf("string");
      expect(c.source).toBeTypeOf("string");
      expect(c.translation).toBeTypeOf("string");
      expect(c.score_min).toBeTypeOf("number");
      expect(c.score_max).toBeTypeOf("number");
      expect(["good", "fair", "poor"]).toContain(c.quality);
    }
  });

  it("has balanced quality distribution", () => {
    const counts = { good: 0, fair: 0, poor: 0 };
    for (const c of fixtures.cases) {
      counts[c.quality]++;
    }
    // Expect at least 3 cases in each tier — keeps the suite representative.
    expect(counts.good).toBeGreaterThanOrEqual(3);
    expect(counts.fair).toBeGreaterThanOrEqual(3);
    expect(counts.poor).toBeGreaterThanOrEqual(3);
  });
});
