import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No code may pick "the caller's workspace" on its own.
 *
 * The workspace switcher sets the `chorus_active_ws` cookie, and `resolveWorkspace` is the one rule
 * that honours it (cookie if still a member, else latest-joined). On 2026-09-29 some 30 routes and the
 * client context each picked a membership themselves — `order('joined_at').limit(1)`, or worse an
 * unordered `limit(1)` — so a user in two workspaces saw one in the UI while routes acted on another.
 *
 * The rule this scan enforces: a `workspace_members` read that narrows to ONE row (`maybeSingle`,
 * `single`, `limit(1)`) must be pinned to a known workspace (`.eq('workspace_id', …)`) — the one
 * `resolveWorkspace` returned, or one the request names and the read is checking membership of — or to
 * one membership row by its id (the team screen acting on a named member, in that member's workspace).
 * Reads of many rows (a roster, a count, "every workspace I am in") are not a choice and pass.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const SCANNED = ["src/app", "src/lib"];

/** Files allowed to choose a membership themselves, and why. */
const EXEMPT: Record<string, string> = {
  "src/lib/assistant/workspace.ts": "resolveWorkspace itself — the one place the latest-joined fallback is decided.",
  "src/lib/data/workspace.ts":
    "the client context: it selects the membership /api/workspace/active names, and falls back to the latest-joined one (the server's own fallback) only when that call fails.",
};

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

/** Each `.from('workspace_members')` chain, up to the statement's end. */
const memberReads = (source: string): string[] => {
  const reads: string[] = [];
  const pattern = /\.from\(\s*['"]workspace_members['"]\s*\)/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const end = source.indexOf(";", match.index);
    reads.push(source.slice(match.index, end === -1 ? undefined : end));
  }
  return reads;
};

const picksOne = (read: string) => /\.maybeSingle\(\)|\.single\(\)|\.limit\(\s*1\s*\)/.test(read);
/** Pinned to a known workspace, or to one membership row by its primary key (whose workspace it carries). */
const pinnedToWorkspace = (read: string) => /\.eq\(\s*['"](workspace_id|id)['"]/.test(read);

describe("workspace membership reads go through resolveWorkspace", () => {
  const scanned = SCANNED.flatMap((dir) => files(join(ROOT, dir))).map((path) => relative(ROOT, path));

  it("scans the tree it claims to (a moved directory must not pass by scanning nothing)", () => {
    expect(scanned).toContain("src/lib/assistant/workspace.ts");
    expect(scanned).toContain("src/app/api/workspace/active/route.ts");
    expect(scanned.length).toBeGreaterThan(200);
  });

  it("no non-exempt file picks a single membership without pinning it to a workspace", () => {
    const offenders = scanned
      .filter((path) => !(path in EXEMPT))
      .flatMap((path) =>
        memberReads(readFileSync(join(ROOT, path), "utf8"))
          .filter((read) => picksOne(read) && !pinnedToWorkspace(read))
          .map((read) => `${path}: ${read.replace(/\s+/g, " ").slice(0, 160)}`),
      );
    expect(offenders).toEqual([]);
  });

  it("every exemption is still needed (a fixed file must leave the list)", () => {
    for (const path of Object.keys(EXEMPT)) {
      const reads = memberReads(readFileSync(join(ROOT, path), "utf8"));
      expect(reads.some((read) => picksOne(read) && !pinnedToWorkspace(read)), path).toBe(true);
    }
  });

  it("detects the pattern it forbids", () => {
    const latest = `supabase.from('workspace_members').select('workspace_id').eq('profile_id', user.id).order('joined_at', { ascending: false }).limit(1).maybeSingle();`;
    const unordered = `supabase.from("workspace_members").select("workspace_id").eq("profile_id", user.id).limit(1).maybeSingle();`;
    const pinned = `supabase.from('workspace_members').select('role').eq('workspace_id', id).eq('profile_id', user.id).maybeSingle();`;
    const roster = `supabase.from('workspace_members').select('id, role').eq('workspace_id', id).order('joined_at');`;
    const check = (src: string) => memberReads(src).some((read) => picksOne(read) && !pinnedToWorkspace(read));
    expect(check(latest)).toBe(true);
    expect(check(unordered)).toBe(true);
    expect(check(pinned)).toBe(false);
    expect(check(roster)).toBe(false);
  });
});
