import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run source tests — never stale compiled copies under dist/.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    /**
     * The Postgres conformance harnesses build a store per test, and each one starts its own PGlite
     * (an embedded Postgres compiled to WASM). With ~113 such tests across parallel files, a single
     * test can legitimately wait seconds for CPU — so the 5s default was timing out tests that were
     * making progress, not hanging. That reads as flakiness, and a suite people re-run until green
     * is worse than a slow one.
     *
     * This raises the ceiling; it does not fix the cause. The real fix is one PGlite per file with
     * per-test schema isolation (the real-server executor already works that way), which matters
     * because #97→#102 add twelve more ports to the same entrypoint. Tracked separately rather than
     * folded into #96.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
