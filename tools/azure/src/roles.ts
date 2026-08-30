/**
 * The least-privileged built-in role each tool needs — REQ-054 (#232), task #236, AC-6 and AC-8.
 *
 * Kept as data rather than prose in the documentation, for the reason every constant in this repository is:
 * the integration page is generated from a table somebody maintains by hand, and a hand-maintained table drifts
 * from the code within a release. Here the *error message* an operator sees and the *row* the docs show come
 * from the same string, so they cannot disagree.
 *
 * **Least-privileged, not sufficient.** `Owner` would satisfy every row and is the wrong answer to write down:
 * an operator copying these into a role assignment should end up with the narrowest grant that works, and a
 * document that says `Contributor` everywhere teaches the opposite habit. Where a purpose-built narrow role
 * exists — `Tag Contributor`, `Monitoring Reader`, `Log Analytics Reader` — it is the one named, even though
 * `Reader` or `Contributor` would also pass.
 *
 * `Reader` is genuinely enough for every read here. That is worth stating plainly, because it means a
 * deployment that only inspects can be granted exactly one role, at one scope, and nothing else.
 */

/** Azure's built-in roles used by this toolkit. Names are the portal's, which is what an administrator types. */
export const READER = "Reader";
export const MONITORING_READER = "Monitoring Reader";
export const LOG_ANALYTICS_READER = "Log Analytics Reader";
export const TAG_CONTRIBUTOR = "Tag Contributor";
/**
 * Restart is per-resource-type, and so is its role.
 *
 * There is no single "restart things" role: restarting a VM needs `Virtual Machine Contributor`, restarting a
 * web app needs `Website Contributor`. Naming one of them for both would be wrong half the time, which is why
 * `RESTART_ROLES` is keyed by type alongside the endpoint table in `arm.ts`.
 */
export const VM_CONTRIBUTOR = "Virtual Machine Contributor";
export const WEBSITE_CONTRIBUTOR = "Website Contributor";
export const CONTAINER_CONTRIBUTOR = "Contributor";

/**
 * Every tool, and the role it needs.
 *
 * A test asserts this covers the toolkit exactly — no tool without a role, no role without a tool. That is the
 * check that keeps AC-8's table honest as tools are added.
 */
export const TOOL_ROLES: Readonly<Record<string, string>> = {
  azure_list_subscriptions: READER,
  azure_list_resource_groups: READER,
  azure_list_resources: READER,
  azure_get_resource: READER,
  azure_query_logs: LOG_ANALYTICS_READER,
  azure_get_metrics: MONITORING_READER,
  azure_list_activity_log: MONITORING_READER,
  azure_tag_resource: TAG_CONTRIBUTOR,
  // The generic answer, refined per resource type at the call site — see `RESTART_ROLES`.
  azure_restart_resource: VM_CONTRIBUTOR,
};
