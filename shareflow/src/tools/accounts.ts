/**
 * The Accounts capabilities — `docs/07-shareflow-integration.md`: *"list destinations and connection
 * health"* (#117).
 *
 * ## The four named functions are not four capabilities
 *
 * The SPEC names `connect-test-account`, `on-linkedin-connected`, `on-meta-connected` and
 * `show-connection-setup` in `twenty-apps/twenty-social`. All four exist; only one is a capability.
 *
 * `on_linkedin_connected` and `on_meta_connected` are **event handlers** — they run *when* a provider
 * connects. The app reacts to a connection; nothing calls them.
 *
 * `show_connection_setup` is the remediation payload, and is wrapped here as `get_connection_setup`.
 *
 * ## Why `connect_test_account` is deliberately not exposed
 *
 * It creates a `socialAccount` row with `isActive: true` and a fake token, described in its own source
 * as a *"dry-run channel that accepts posts without contacting any platform"*. That row then appears as
 * a destination.
 *
 * So an assistant holding that tool has a way to **manufacture a destination that silently swallows
 * posts.** Asked to publish somewhere it cannot reach, the cheapest path to a successful-looking
 * outcome is to create a dry-run channel and publish there — reporting success while nothing went out.
 *
 * It is a legitimate developer affordance for exercising fan-out before platform approval, and it is not
 * something a model should be able to reach. `disconnectAccount` is excluded from the other direction:
 * destructive, and a user action.
 *
 * ## Connecting stays a user action (AC-4)
 *
 * There is no capability here that changes a connection, in either direction. OAuth requires the user's
 * consent at the platform, and the assistant's job is to say *where to go and what is needed* — which
 * is what `get_connection_setup` returns.
 */
import { z } from "zod";
import { AgentPlatformError, asId, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import {
  type AccountHealth,
  type ConnectedAccount,
  type ConnectionSetup,
  type SocialAccountId,
} from "../services/index.js";
import type { ShareFlowToolContext, ShareFlowToolFactory } from "./index.js";

/**
 * What to do about a destination that is not working.
 *
 * A stable code, not a sentence. docs/01 requires contracts to carry *"stable codes and structured data
 * — never pre-localized user prose"*, and the assistant is the thing composing the sentence anyway.
 */
export const REMEDIATION_ACTIONS = ["none", "reconnect", "configure-credentials"] as const;
export type RemediationAction = (typeof REMEDIATION_ACTIONS)[number];

export type AccountRemediation = {
  readonly action: RemediationAction;
  /** Whether `get_connection_setup` returns the concrete fields this action needs. */
  readonly setupGuideHelps: boolean;
};

/**
 * The fix, derived from the fault.
 *
 * In one place rather than inferred at each call site: #121's accounts context provider needs the same
 * answer, and two derivations would eventually disagree about what "expired" means.
 *
 * `expired` and `revoked` are both `reconnect` — the user re-runs OAuth in the app and no credential
 * changes. `not-configured` is different in kind: ShareFlow's `NotConfiguredError` says *"add
 * credentials"*, which is an admin registering the deployment's OAuth app, and no amount of reconnecting
 * will help until that is done.
 */
export const remediationFor = (health: AccountHealth): AccountRemediation => {
  switch (health) {
    case "active":
      return { action: "none", setupGuideHelps: false };
    case "expired":
    case "revoked":
      return { action: "reconnect", setupGuideHelps: false };
    case "not-configured":
      return { action: "configure-credentials", setupGuideHelps: true };
  }
};

/**
 * Patterns that mean a secret has reached a place it should not be.
 *
 * **Deliberately conservative, and this is defence in depth — not the guarantee.** The guarantee is
 * structural: the account view below carries stable codes, ids and a timestamp, and the only
 * platform-supplied free text it passes through is `displayName`. There is nowhere for a token to hide.
 *
 * This exists because the underlying records genuinely do hold tokens — ShareFlow selects
 * `token_expires_at` beside them, twenty-social's `setAccountToken` writes them — so an adapter bug is a
 * real possibility rather than a hypothetical one. It **fails** rather than scrubbing: a silent scrub
 * would hide the bug that produced it, and a destination whose name is a token is not a destination
 * anyone should publish to.
 *
 * What it cannot do: recognise an opaque secret that happens to look like a name. It catches the shapes
 * that actually occur.
 */
const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "bearer token", pattern: /\bBearer\s+\S+/i },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}/ },
  { name: "token field", pattern: /\b(access|refresh|client)[-_]?(token|secret)\b/i },
  { name: "api key prefix", pattern: /\b(sk|pk|rk)-[A-Za-z0-9]{16,}/ },
  // `SOMETHING=value`. Caught separately from the name patterns above because the *name* of a
  // credential variable is legitimate text — `LINKEDIN_CLIENT_SECRET` is what a setup guide is supposed
  // to say. What is never legitimate is a name with a value attached to it.
  { name: "credential assignment", pattern: /\b[A-Z][A-Z0-9_]{2,}\s*=\s*\S{8,}/ },
  // A long unbroken run of secret-shaped characters. A Page or channel name is words; 48 characters
  // with no separator is not a name.
  { name: "opaque secret", pattern: /[A-Za-z0-9_\-]{48,}/ },
];

/**
 * An environment variable name and nothing else.
 *
 * Used instead of `assertNoSecrets` for `credentialVariables`, because that field is the one place where
 * the *word* "SECRET" is expected — `LINKEDIN_CLIENT_SECRET` is exactly what the setup guide should say.
 * A pattern that flagged it would break the legitimate case, and one that did not would miss
 * `LINKEDIN_CLIENT_SECRET=WPL_AP1.…`, which is how a value actually arrives.
 *
 * So the check is the field's own shape rather than a search for secrets: a variable name is upper-case
 * letters, digits and underscores. Anything else — an `=`, a quote, a space, a dot — is not a name, and
 * whatever follows it is a value. My first version of this used the generic scanner and let the
 * assignment through; a test caught it.
 */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export const assertEnvVarName = (value: string): string => {
  if (!ENV_VAR_NAME.test(value))
    throw new AgentPlatformError({
      code: "provider_error",
      message: "refusing to return credentialVariables: an entry is not a bare environment variable name",
      retryable: false,
      details: { field: "credentialVariables" },
    });
  return value;
};

/** Throws `provider_error` when `value` looks like it contains a secret. Returns it otherwise. */
export const assertNoSecrets = (value: string, field: string): string => {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(value))
      throw new AgentPlatformError({
        code: "provider_error",
        message: `refusing to return ${field}: it looks like it contains a ${name}`,
        retryable: false,
        // The offending value is deliberately absent from `details` — reporting a suspected secret in
        // an error payload would put it in exactly the place this check exists to keep it out of.
        details: { field },
      });
  }
  return value;
};

/**
 * What the assistant sees about a destination.
 *
 * Built field by field. No spread, and no `healthDetail`: that field is adapter-authored prose, and the
 * obvious way to fill it is with the provider's error message.
 */
const accountView = (account: ConnectedAccount) => ({
  accountId: account.id,
  platformId: account.platformId,
  displayName: assertNoSecrets(account.displayName, "displayName"),
  health: account.health,
  remediation: remediationFor(account.health),
  ...(account.accessExpiresAt === undefined ? {} : { accessExpiresAt: account.accessExpiresAt }),
});

const setupView = (setup: ConnectionSetup) => ({
  redirectUrl: setup.redirectUrl,
  credentialsPageUrl: setup.credentialsPageUrl,
  ...(setup.warning === undefined ? {} : { warning: setup.warning }),
  platforms: setup.platforms.map((platform) => ({
    platformId: platform.platformId,
    label: platform.label,
    consoleUrl: platform.consoleUrl,
    // Names only. A value here would be the deployment's client secret.
    credentialVariables: platform.credentialVariables.map(assertEnvVarName),
    consoleFields: platform.consoleFields.map((f) => ({ label: f.label, url: f.url })),
    scopes: platform.scopes,
    ...(platform.reviewNeeded === undefined ? {} : { reviewNeeded: platform.reviewNeeded }),
  })),
});

const listAccountsSchema = z.object({}).strict();

export const listAccountsTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "list_accounts",
    label: "List destinations",
    description:
      "List the destinations this workspace can publish to, each with its connection health and, when something is wrong, what would fix it. Read this before proposing where a post should go — a destination that is expired or not configured cannot receive one.",
    category: "accounts",
    effect: "read",
    inputSchema: listAccountsSchema,
    delegatesTo: "ConnectorService.listAccounts",
    delegate: async (_input: z.infer<typeof listAccountsSchema>, context) => ({
      accounts: (await services.connectors.listAccounts(context)).map(accountView),
    }),
  });

const checkAccountHealthSchema = z
  .object({
    // Bounded: each id costs a round trip to the platform.
    accountIds: z.array(z.string().min(1)).min(1).max(20),
  })
  .strict();

export const checkAccountHealthTool: ShareFlowToolFactory = ({
  services,
  deps,
}: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "check_account_health",
    label: "Re-check destinations",
    description:
      "Re-check specific destinations against their platform, rather than reading the stored status. Use it when a publish has just failed or the user says a connection is broken; `list_accounts` is enough for everything else, because this contacts each platform.",
    category: "accounts",
    effect: "read",
    inputSchema: checkAccountHealthSchema,
    delegatesTo: "ConnectorService.checkHealth",
    delegate: async (input: z.infer<typeof checkAccountHealthSchema>, context) => ({
      accounts: (
        await services.connectors.checkHealth(context, {
          accountIds: input.accountIds.map((id) => asId<SocialAccountId>(id)),
        })
      ).map(accountView),
    }),
  });

const getConnectionSetupSchema = z.object({}).strict();

export const getConnectionSetupTool: ShareFlowToolFactory = ({
  services,
  deps,
}: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "get_connection_setup",
    label: "How to connect a platform",
    description:
      "What a platform needs before an account on it can be connected: the redirect URL to register, the exact fields each platform's developer console asks for, the scopes, and what platform review is required. Use it when a destination reports that credentials are not configured, or when the user asks how to connect. Connecting itself is something the user does in the app — this tells them what to do, it does not do it.",
    category: "accounts",
    effect: "read",
    inputSchema: getConnectionSetupSchema,
    delegatesTo: "ConnectorService.getConnectionSetup",
    delegate: async (_input: z.infer<typeof getConnectionSetupSchema>, context) =>
      setupView(await services.connectors.getConnectionSetup(context)),
  });

/**
 * The complete Accounts catalog. Pinned by a test, like Campaigns — so adding a capability that changes
 * a connection has to be a deliberate change to an assertion about what this category can do.
 */
export const ACCOUNT_TOOL_NAMES = [
  "list_accounts",
  "check_account_health",
  "get_connection_setup",
] as const;

export const ACCOUNT_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listAccountsTool,
  checkAccountHealthTool,
  getConnectionSetupTool,
];
