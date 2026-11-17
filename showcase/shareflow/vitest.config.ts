import { defineConfig } from "vitest/config";

/**
 * Standalone since this package moved out of the retinue monorepo.
 *
 * The reporter helper it used to import lived at `../vitest.shared.js` and existed so five workspaces
 * could emit JUnit XML for Jenkins trend views without running their suites twice. There is one
 * workspace here and CI is GitHub Actions, so the conditional is inlined rather than shared — the
 * behaviour is unchanged and costs nothing when the variable is unset, which is everywhere except a
 * CI run that asks for it.
 */
const reporters = (): { reporters: string[]; outputFile?: Record<string, string> } => {
  const dir = process.env["RETINUE_JUNIT_DIR"];
  if (dir === undefined || dir.trim() === "") return { reporters: ["default"] };
  return { reporters: ["default", "junit"], outputFile: { junit: `${dir}/shareflow.junit.xml` } };
};

export default defineConfig({
  test: {
    ...reporters(),
    /**
     * Source tests only, never a compiled copy under `dist/`.
     *
     * `dist` holds a built copy of every test the build does not exclude, and a suite that runs both
     * reports twice as many passing tests as it has — which reads as coverage rather than as a
     * duplicate.
     */
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
