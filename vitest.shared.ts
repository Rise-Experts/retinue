/**
 * Reporters, shared by every workspace's vitest config.
 *
 * Exists for one reason: Jenkins can show **test trends** — this test has failed 3 of the last 20 builds — and a
 * console log cannot. That needs JUnit XML, and producing it by running the suites a second time with a different
 * reporter would double the slowest part of the build to collect data about the first run.
 *
 * So the reporter list is conditional on an environment variable, and the suites run **once**. Absent, nothing
 * changes: `npm test` on a workstation behaves exactly as it did.
 *
 * Shared rather than copied into five configs, because the failure mode of copying is that four of them get the
 * reporter and the fifth silently reports no tests — which in a trend view reads as a suite that passed.
 */

/** Where JUnit XML goes, when anything asked for it. Set by CI; unset everywhere else. */
export const JUNIT_DIR = "RETINUE_JUNIT_DIR";

export const reporters = (workspace: string): { reporters: string[]; outputFile?: Record<string, string> } => {
  const dir = process.env[JUNIT_DIR];
  if (dir === undefined || dir.trim() === "") return { reporters: ["default"] };
  return {
    reporters: ["default", "junit"],
    // Named per workspace: one path would have five suites overwriting each other, and the trend would show
    // whichever finished last as though it were the whole build.
    outputFile: { junit: `${dir}/${workspace}.junit.xml` },
  };
};
