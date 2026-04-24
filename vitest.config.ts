import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Stress suite (tests/stress/**/*.stress.test.ts) is intentionally
    // excluded — its inference latency on CPU is unbounded. Run it via
    //   npm run test:stress
    exclude: ["**/node_modules/**", "**/dist/**", "tests/stress/**"],
    testTimeout: 30000, // 30 seconds for integration tests
  },
});
