import { defineConfig } from "vitest/config";

/**
 * `test` is `tsc -b && vitest run`, not `vitest run` — and that is a correctness fix, not tidiness.
 *
 * This package value-imports `@agentkit/backend`, whose `main` is `dist/index.js`. So `vitest run`
 * alone tests whatever was last built: edit the backend, run this suite, and it passes against the
 * previous version. #115's sabotage pass found it — disabling input validation in the envelope failed
 * nothing here until the build was re-run, at which point eight tests failed. The suite had been
 * correct only because every earlier session happened to run `tsc -b` first.
 *
 * `tsc -b` is incremental, so this costs nothing when the build is current. `frontend` is left alone:
 * R2 restricts it to type-only imports of the backend, which vitest strips.
 */
export default defineConfig({
  test: {
    // Only run source tests — never stale compiled copies under dist/ (AC-4). Same shape as the other
    // workspaces: `dist` holds a compiled copy of every test that is not excluded from the build, and
    // a suite that runs both reports twice as many passing tests as it has.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
