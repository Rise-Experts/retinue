import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run source tests — never stale compiled copies under dist/ (AC-4). Same shape as the other
    // workspaces: `dist` holds a compiled copy of every test that is not excluded from the build, and
    // a suite that runs both reports twice as many passing tests as it has.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
