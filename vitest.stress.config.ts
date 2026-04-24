/**
 * Vitest config for the stress suite.
 *
 * Run with:  npm run test:stress
 *
 * Stress tests live in tests/stress/**\/*.stress.test.ts and are excluded
 * from the default `npm test`. They typically require a real Python
 * worker with `unbabel-comet` installed; without it they auto-skip.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/stress/**/*.stress.test.ts"],
    // 5 minutes per test by default — model inference on long inputs can
    // legitimately take ~3 minutes on CPU.
    testTimeout: 300_000,
    // Don't kill workers between tests; keep the model loaded.
    hookTimeout: 60_000,
  },
});
