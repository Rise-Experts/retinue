import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run source tests — never stale compiled copies under dist/.
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
