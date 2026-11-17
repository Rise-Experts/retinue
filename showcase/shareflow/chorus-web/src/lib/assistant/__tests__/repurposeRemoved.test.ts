import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NAV_ITEMS } from "../../routeMeta";
import * as tools from "../toolsViaAgentkit";

/**
 * The Repurpose page is gone — #494, part of the one-Assistant epic (#493).
 *
 * Turning a link or text into posts is the Assistant's job now (`repurpose_source`,
 * `repurpose_to_formats`, `read_source` tools). What must survive is the backend other callers use:
 * the MCP server's `repurpose` tool, through `repurposeViaAgentkit`.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const at = (p: string) => resolve(SRC, p);

describe("the page and its routes are removed", () => {
  it.each([
    "app/(dashboard)/repurpose/page.tsx",
    "app/api/ai/repurpose/route.ts",
    "app/api/ai/repurpose/save/route.ts",
    "app/api/ai/read-source/route.ts",
  ])("%s no longer exists", (p) => {
    expect(existsSync(at(p))).toBe(false);
  });

  it("is not in the sidebar", () => {
    expect(NAV_ITEMS.map((i) => i.id)).not.toContain("repurpose");
  });

  it("took its screen-only adapter with it", () => {
    expect("repurposeToFormatsViaAgentkit" in tools).toBe(false);
  });
});

describe("what other callers use is kept", () => {
  it("keeps repurposeViaAgentkit for the MCP server", () => {
    expect(typeof tools.repurposeViaAgentkit).toBe("function");
    const mcp = readFileSync(at("lib/mcp/server.ts"), "utf8");
    expect(mcp).toContain("repurposeViaAgentkit({");
    expect(mcp).toMatch(/repurpose: \{ title: 'Repurpose into posts'/);
  });

  it("points people at the Assistant instead", () => {
    const en = JSON.parse(readFileSync(resolve(SRC, "..", "messages", "en.json"), "utf8"));
    expect(en.assistant.blankSubtitle).toContain("turn a link into posts");
    expect(en.Repurpose).toBeUndefined();
  });
});
