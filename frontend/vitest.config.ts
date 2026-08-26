import { defineConfig } from "vitest/config";
import { reporters } from "../vitest.shared.js";

export default defineConfig({
  test: {
    // JUnit XML when CI asks for it, so Jenkins can show test trends. See `vitest.shared.ts`.
    ...reporters("frontend"),
    // Only run source tests — never stale compiled copies under dist/.
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
