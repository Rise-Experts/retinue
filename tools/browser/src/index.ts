/**
 * Drive a real browser, when a page will not yield to a fetch — REQ-055 (#237), task #239.
 *
 * **The escalation, not the default.** `web_scrape` handles most pages for the cost of one request; this costs
 * a process, memory, and seconds. The tool descriptions say so in their first sentence, and a `find_tools`
 * test asserts that a query about reading a page ranks `web_scrape` above anything here — because a browser is
 * the more capable-*sounding* tool and a model will otherwise reach for it first.
 *
 * **No browser is bundled.** Chromium is ~150MB, its build has to match the driver's, and a package that
 * downloads a binary on install fails in every locked-down environment it will actually be deployed into. The
 * browser is a runtime prerequisite the operator provides, and the integration page states it plainly.
 *
 * The isolation argument — what #216's `Sandbox` gave, what is unavailable to a process that needs network,
 * and what replaces it — is written out in `docs/30-browser-isolation.md`. It is an argument rather than a
 * claim that this "uses the sandbox", because the strongest control in that port is `--network=none` and a
 * browser cannot have it.
 */

import type { Tool, ToolProvider } from "@retinue/agentkit/tools";

import { browserTools, type BrowserToolsConfig } from "./tools.js";
import { createSessionManager, type SessionManagerOptions } from "./session.js";
import type { BrowserDriver } from "./driver.js";

export { browserTools, FORBIDDEN_ARGUMENT_NAMES, MAX_SCREENSHOT_BYTES, MAX_TYPE_LENGTH } from "./tools.js";
export type { BrowserToolsConfig } from "./tools.js";
export { ElementChangedError, nextSnapshotId, snapshotOf } from "./driver.js";
export type { BrowserDriver, TargetedAction } from "./driver.js";
export {
  createReferenceRegistry,
  StaleReferenceError,
  UnknownReferenceError,
} from "./refs.js";
export type { ElementHandle, ReferenceRegistry, Snapshot } from "./refs.js";
export {
  createSessionManager,
  DEFAULT_LIFETIME_MS,
  DEFAULT_MEMORY_KB,
  DEFAULT_MAX_SESSIONS,
  MAX_LIFETIME_MS,
  MAX_MEMORY_KB,
  SessionEndedError,
  TooManySessionsError,
} from "./session.js";
export type { Session, SessionLimits, SessionManager, SessionManagerOptions } from "./session.js";
export { nodeSpawner, psMemory, supervise } from "./supervisor.js";
export type { MeasureMemory, Spawner, Supervised, SupervisorOptions } from "./supervisor.js";

export type BrowserToolkitConfig = SessionManagerOptions & {
  /**
   * Required. There is no default driver, and that is deliberate.
   *
   * A default would mean this package decides how a browser is launched and isolated on the operator's host,
   * which is precisely the decision `docs/30-browser-isolation.md` argues must be made explicitly. A toolkit
   * that silently spawns a browser because it found one on the PATH is the "works on the machine where it was
   * configured" shape, with a much larger blast radius than usual.
   */
  readonly driver: BrowserDriver;
  readonly timeoutMs?: number;
  readonly resolve?: BrowserToolsConfig["resolve"];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
};

export const select = (
  all: readonly Tool[],
  config: Pick<BrowserToolkitConfig, "include" | "exclude">,
): readonly Tool[] => {
  if (config.include !== undefined && config.exclude !== undefined) {
    throw new Error(
      "createBrowserToolkit was given both include and exclude. Pick one: include names what ships, exclude names what does not.",
    );
  }
  const known = new Set(all.map((tool) => tool.descriptor.name));
  const requested = config.include ?? config.exclude ?? [];
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `createBrowserToolkit was given ${config.include === undefined ? "exclude" : "include"} names this toolkit ` +
        `does not have: ${unknown.join(", ")}. It has: ${[...known].join(", ")}.`,
    );
  }
  if (config.include !== undefined) {
    const wanted = new Set(config.include);
    return all.filter((tool) => wanted.has(tool.descriptor.name));
  }
  if (config.exclude !== undefined) {
    const unwanted = new Set(config.exclude);
    return all.filter((tool) => !unwanted.has(tool.descriptor.name));
  }
  return all;
};

export const createBrowserToolkit = (config: BrowserToolkitConfig): ToolProvider => {
  /**
   * The driver is told whenever a session ends, however it ends.
   *
   * Without this the manager and the toolkit each owned half of a session and nothing owned both: a session
   * killed by a cap — or closed because a page redirected itself somewhere private — was forgotten here and
   * left open in the browser. For a hosted driver, which has no local process to kill, this hook is the only
   * teardown there is.
   */
  const sessions = createSessionManager({
    ...config,
    onClose: async (id) => {
      await config.driver.close({ sessionId: id }).catch(() => {});
    },
  });
  const tools = select(
    browserTools({
      driver: config.driver,
      sessions,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.resolve === undefined ? {} : { resolve: config.resolve }),
    }),
    config,
  );
  return {
    id: "browser",
    async listTools() {
      return tools;
    },
  };
};

/**
 * The interaction tools, and their effect — stated as data so the exact-list test can assert it.
 *
 * `internal-write` is the honest label for a click: it changed something on somebody else's server, and this
 * package cannot know what. `external-write` would claim a certainty nobody has and would gate expanding an
 * accordion behind the same approval as sending money. See the header of `tools.ts`.
 */
export const BROWSER_EFFECTS: Readonly<Record<string, "read" | "internal-write">> = {
  browser_navigate: "read",
  browser_read: "read",
  browser_screenshot: "read",
  browser_click: "internal-write",
  browser_type: "internal-write",
  browser_close: "internal-write",
};

/** No credential of any kind — #260 AC-2. A driver may need one; these tools never see it. */
export const BROWSER_AUTH = { modes: [] as const, schemes: [] as const };

export const BROWSER_TOOL_NAMES = [
  "browser_navigate",
  "browser_read",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_close",
] as const;
