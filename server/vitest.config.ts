import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Matches the backend's raised ceiling: an end-to-end host test starts a Yoga instance and
    // consumes a subscription, which is slower than a unit test but not slow enough to be a problem.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
