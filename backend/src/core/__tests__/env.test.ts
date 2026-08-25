/**
 * Reading configuration across the rename — #192.
 *
 * A deprecation path nobody exercises is a deprecation path that does not work, and this one has exactly one
 * job: keep an existing deployment running for a release while its variables are corrected. If it is broken, the
 * symptom is a missing database URL, which looks like a missing database URL rather than like a rename.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readEnv, resetEnvWarnings } from "../env.js";

beforeEach(() => resetEnvWarnings());

describe("readEnv", () => {
  it("prefers the current name", () => {
    const warn = vi.fn();
    const value = readEnv({ RETINUE_DATABASE_URL: "new", AGENTKIT_DATABASE_URL: "old" }, "DATABASE_URL", warn);
    expect(value).toBe("new");
    // No warning: a deployment that has already migrated should hear nothing.
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the legacy name and says so", () => {
    const warn = vi.fn();
    expect(readEnv({ AGENTKIT_DATABASE_URL: "old" }, "DATABASE_URL", warn)).toBe("old");
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    // Both names, and the deadline. A warning that does not say what to change is a warning people filter out.
    expect(message).toContain("AGENTKIT_DATABASE_URL");
    expect(message).toContain("RETINUE_DATABASE_URL");
    expect(message).toContain("next minor release");
  });

  it("warns once per variable, not once per read", () => {
    // A worker reads its configuration on every job in some hosts. The same line a thousand times is a log
    // nobody reads, which is the same outcome as not warning.
    const warn = vi.fn();
    const env = { AGENTKIT_REDIS_URL: "redis://x" };
    for (let i = 0; i < 5; i += 1) readEnv(env, "REDIS_URL", warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("treats an empty value as unset, under either name", () => {
    /**
     * `RETINUE_X=""` is what a half-finished migration looks like — the new variable added to a template and
     * never filled in. Honouring it would shadow a working legacy value and take the deployment down at exactly
     * the moment the fallback exists to prevent that.
     */
    const warn = vi.fn();
    expect(readEnv({ RETINUE_REDIS_URL: "", AGENTKIT_REDIS_URL: "redis://x" }, "REDIS_URL", warn)).toBe("redis://x");
    expect(readEnv({ RETINUE_REDIS_URL: "", AGENTKIT_REDIS_URL: "" }, "REDIS_URL", warn)).toBeUndefined();
  });

  it("returns undefined when neither is set, without warning", () => {
    // An unset optional variable is not a deprecation; warning about it would train people to ignore the warning
    // that matters.
    const warn = vi.fn();
    expect(readEnv({}, "LOG_LEVEL", warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
