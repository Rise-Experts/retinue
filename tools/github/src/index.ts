/**
 * GitHub tools — REQ-047 (#206) task #214, extended to the full surface by REQ-051 (#222) task #223.
 *
 * The first sibling toolkit, and therefore the pattern the other twenty copy. Everything unusual here is a
 * decision about that pattern rather than about GitHub.
 *
 * ## Why this is not inside `@retinue/agentkit`
 *
 * A vendor API change must not be a runtime release. GitHub deprecating an endpoint should bump this package
 * and nothing else — and the runtime's root, which reaches nothing third-party, stays that way. The runtime is
 * a `peerDependency`: this package needs *a* runtime, not its own copy of one.
 *
 * ## Why there is no token in this file
 *
 * A `credentialRef` and a resolver, both supplied by the host, resolved **per call**. `process.env.GITHUB_TOKEN`
 * would work perfectly for one tenant and would be copied into twenty more packages before anybody noticed
 * that a second customer needs a second token for the same tool.
 *
 * ## Why every write says `confirms` or `destroys`
 *
 * Those set effect, approval policy and idempotency together, and the type forbids overriding them. `effect:
 * "read"` on `create_issue` would skip the approval gate and carry no idempotency key, and nothing in a build
 * can notice — `read` is a valid value and the compiler cannot know what the function does. #228 established
 * that this is *derived*: the effect alone decides both, so the three cannot drift apart.
 *
 * ## Why 44 tools ship and a deployment gets ten
 *
 * ~35 tokens per catalogue entry (#221) × 44 is ~1,540 resident on every turn, and #210 measured that a
 * *catalogue budget* — dropping entries at run time — costs 19–23 points of selection accuracy, because a
 * plausible resident near-duplicate beats searching for the right tool. The same measurement found per-tenant
 * selection to be the lever that works.
 *
 * So selection happens at **wiring** time: `include` / `exclude` at construction. The toolkit knows everything
 * GitHub can do; a deployment ships the ten it uses.
 */

import type { CredentialRef, CredentialResolver, Tool, ToolProvider, ToolkitAuth } from "@retinue/agentkit/tools";

import { actionTools } from "./actions.js";
import { codeTools } from "./code.js";
import { issueTools } from "./issues.js";
import { projectTools } from "./projects.js";
import { createTransport } from "./transport.js";

export { parseIssueRef, fieldValueFor } from "./projects.js";
export { createTransport, describeFailure } from "./transport.js";

export type GitHubToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  /** Defaults to `https://api.github.com`. Set for GitHub Enterprise. */
  readonly baseUrl?: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Ship only these. Mutually exclusive with `exclude`.
   *
   * An unknown name is **refused**, not ignored — see `select`.
   */
  readonly include?: readonly string[];
  /** Ship everything except these. Mutually exclusive with `include`. */
  readonly exclude?: readonly string[];
};

/**
 * Narrow the surface, and **refuse a name that is not in it** — AC-3.
 *
 * The failure this exists to prevent is quiet and one-directional. `exclude: ["github_delete_fille"]` with a
 * typo, silently ignored, ships `github_delete_file` to an agent whose operator believed they had removed it.
 * Nothing fails, nothing logs, and the operator's belief is wrong until the day it matters. A typo in
 * `include` is the mirror image and merely annoying — the tool is missing and somebody notices in a minute.
 *
 * Both are refused, because the check that only guards the dangerous direction is the one nobody trusts.
 * Nearest-match suggestions are offered: `github_serch_issues` is a transposition away from a real name, and
 * naming it turns a two-minute hunt into a fix.
 */
export const select = (
  all: readonly Tool[],
  config: Pick<GitHubToolkitConfig, "include" | "exclude">,
): readonly Tool[] => {
  if (config.include !== undefined && config.exclude !== undefined) {
    throw new Error(
      "createGitHubToolkit was given both include and exclude. Pick one: include names what ships, exclude names what does not.",
    );
  }
  const known = new Set(all.map((tool) => tool.descriptor.name));
  const requested = config.include ?? config.exclude ?? [];
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    const suggest = (name: string): string => {
      // A cheap nearest match: shares the prefix, or is one edit away in length and mostly the same letters.
      const candidates = [...known].filter((candidate) => {
        if (Math.abs(candidate.length - name.length) > 2) return false;
        const a = [...name].sort().join("");
        const b = [...candidate].sort().join("");
        let shared = 0;
        for (let i = 0, j = 0; i < a.length && j < b.length; ) {
          if (a[i] === b[j]) { shared += 1; i += 1; j += 1; }
          else if ((a[i] as string) < (b[j] as string)) i += 1;
          else j += 1;
        }
        return shared >= name.length - 2;
      });
      return candidates.length === 0 ? "" : ` Did you mean ${candidates.slice(0, 3).join(", ")}?`;
    };
    throw new Error(
      `createGitHubToolkit was given ${config.include === undefined ? "exclude" : "include"} names this toolkit does not have: ` +
        `${unknown.join(", ")}.${suggest(unknown[0] as string)}`,
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

export const createGitHubToolkit = (config: GitHubToolkitConfig): ToolProvider => {
  const transport = createTransport(config);
  const all: readonly Tool[] = [
    ...issueTools(transport),
    ...codeTools(transport),
    ...projectTools(transport),
    ...actionTools(transport),
  ];
  // At construction, so a typo'd exclusion fails at boot rather than at the first turn that needed the tool.
  const tools = select(all, config);

  return {
    id: "github",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What GitHub accepts — #260 AC-2.
 *
 * A PAT and an OAuth access token are both presented as a bearer, which is exactly why `modes` and `schemes`
 * are separate: the wire format is the same and the way a tenant gets one is not. A GitHub App installation
 * token is a third mode and is not offered yet.
 */
export const GITHUB_AUTH: ToolkitAuth = { modes: ["token", "oauth2"], schemes: ["bearer"] };

/**
 * Every tool this toolkit offers, so a host can preload by name and `docs/23` can be checked against it.
 *
 * Grouped as the specification groups them, and in the order `createGitHubToolkit` assembles them, so the test
 * that compares this list with the declarations compares order too — a tool added to a group and forgotten
 * here is a failure rather than a silent divergence.
 */
export const GITHUB_TOOL_NAMES = [
  // Group A — issues and pull requests.
  "github_list_issues",
  "github_create_issue",
  "github_comment",
  "github_merge_pull_request",
  "github_search_issues",
  "github_get_issue",
  "github_update_issue",
  "github_close_issue",
  "github_reopen_issue",
  "github_list_pull_requests",
  "github_get_pull_request",
  "github_search_pull_requests",
  "github_create_pull_request",
  "github_update_pull_request",
  "github_review_pull_request",
  "github_close_pull_request",
  // Group B — code and repository.
  "github_search_code",
  "github_get_file",
  "github_list_directory",
  "github_list_commits",
  "github_get_commit",
  "github_list_branches",
  "github_list_tags",
  "github_create_branch",
  "github_write_file",
  "github_delete_file",
  // Group C — Projects v2.
  "github_list_projects",
  "github_get_project",
  "github_create_project",
  "github_add_project_item",
  "github_set_project_field",
  "github_remove_project_item",
  // Group D — releases, workflows, labels, milestones.
  "github_list_releases",
  "github_get_release",
  "github_create_release",
  "github_list_workflow_runs",
  "github_get_workflow_run",
  "github_get_workflow_run_logs",
  "github_rerun_workflow",
  "github_dispatch_workflow",
  "github_list_labels",
  "github_add_labels",
  "github_remove_label",
  "github_list_milestones",
] as const;
