/**
 * `ConnectorService` over `social_accounts` — REQ-041 (#190), and what makes `publish` a usable workflow.
 *
 * The fifth adapter, and it exists because of a gap the publishing work exposed: all five publishing
 * capabilities worked and **nothing could tell the assistant where to publish**. `list_accounts` is the only
 * capability that surfaces an account id, it needs this service, and without it a real turn could do nothing
 * but guess — which it did, inventing `accountIds: ["linkedin123"]`.
 *
 * ## Two of the three methods depend on facts this package cannot read
 *
 * That is the shape of this adapter and the reason its dependencies look the way they do. `social_accounts`
 * answers "which destinations exist and what does the store think of them". It does not answer:
 *
 * - **"Is the platform's OAuth app configured?"** In ShareFlow that is `isPlatformConfigured`, which calls
 *   `connector.isConfigured()` — a **runtime read of environment variables in ShareFlow's own process**. This
 *   package cannot see them, and reaching for `process.env` here is forbidden by the boundary checks for
 *   exactly this class of reason. So `not-configured` is only ever reported when a deployment supplies
 *   `configuredPlatforms`; inventing it from a database row would be a guess presented as a status.
 * - **"What does connecting this platform require?"** Redirect URLs, developer-console field labels, scopes
 *   and environment *variable names* are deployment and platform knowledge, not rows. `setup` is therefore
 *   **required**: there is nothing truthful to return without it, and a hard-coded table of console URLs and
 *   variable names would be this package asserting another deployment's configuration.
 *
 * ## Read the constraint, not the calling code
 *
 * I first mapped this vocabulary by grepping ShareFlow for what it *writes* — `ACTIVE` from the connect
 * callback, `EXPIRED` from the refresh route and the TikTok webhook — and concluded the port's `revoked` was
 * unreachable. `social_accounts_status_check` says otherwise:
 *
 * ```
 * CHECK (status = ANY (ARRAY['ACTIVE', 'EXPIRED', 'DISCONNECTED']))
 * ```
 *
 * Three values, and `DISCONNECTED` is `revoked`. The constraint is the authority on what a column can hold;
 * the calling code only shows what one version of it happens to write today. The database caught this by
 * refusing a fixture — the same lesson as the post-status trigger, which is likewise the authority on that
 * vocabulary rather than the routes that drive it.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

import type {
  AccountHealth,
  ConnectedAccount,
  ConnectionSetup,
  ConnectorService,
} from "../../services/index.js";

/**
 * What `social_accounts.status` may hold, from `social_accounts_status_check` — three values, all mapped.
 *
 * `DISCONNECTED` is `revoked`. It is **permitted but unwritten**: no route in ShareFlow's current code sets
 * it, so it will not appear in today's data — which is a different and more useful statement than "the store
 * cannot hold it", and the reason this arm exists rather than being dropped as dead.
 */
export const ACCOUNT_STATUS_FROM_DB: Readonly<Record<string, AccountHealth>> = {
  ACTIVE: "active",
  EXPIRED: "expired",
  DISCONNECTED: "revoked",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asUuid = (field: string, value: string): string => {
  if (!UUID.test(value.trim())) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `${field} must be a UUID — got ${JSON.stringify(value.slice(0, 60))}.`,
      retryable: false,
    });
  }
  return value.trim();
};

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * A stored status as health. An unrecognised one reads as `expired`, the cautious direction.
 *
 * Exported because it **cannot be reached through a row**: `social_accounts_status_check` admits exactly the
 * three mapped values, so a fourth can only arrive from a future migration. The arm is not dead code — that
 * constraint has grown before — but the only honest way to test it is to call this directly and say so.
 *
 * The alternatives both assert a working connection. `active` on a value this code does not understand would
 * have the assistant propose a destination that may not accept a post; the cost of being wrong the other way
 * is a warning about a connection that is fine.
 */
export const accountHealthFrom = (status: string | null): AccountHealth =>
  (status === null ? undefined : ACCOUNT_STATUS_FROM_DB[status.toUpperCase()]) ?? "expired";

type AccountRow = {
  id: string;
  platform: string;
  account_name: string;
  status: string | null;
  token_expires_at: string | Date | null;
};

/**
 * The columns, and **not `auth_tokens`**.
 *
 * `social_accounts.auth_tokens` holds the access and refresh tokens. It is never selected, because the way a
 * credential reaches a model prompt is a `select *` written by someone who did not think about it — and
 * `tools/accounts.ts` scans `displayName` for secrets precisely because that is the one field here carrying
 * platform-supplied free text. Not reading the column at all is stronger than trusting a mapper to drop it.
 */
const ACCOUNT_COLUMNS = `select id, platform, account_name, status, token_expires_at
                           from public.social_accounts`;

export type ConnectorDeps = {
  readonly sql: SqlExecutor;
  /**
   * What connecting a platform requires, from the deployment. **Required.**
   *
   * Redirect URL, credentials page, per-platform console fields, scopes, environment variable names — every
   * one of them is deployment or platform knowledge rather than a database row. A default here would be this
   * package inventing another deployment's configuration, and the failure mode is the worst kind: an
   * assistant confidently telling a user to set a variable that deployment does not use.
   */
  readonly setup: (context: ExecutionContext) => Promise<ConnectionSetup> | ConnectionSetup;
  /**
   * Which platforms have working credentials, if the deployment can say.
   *
   * Absent means `not-configured` is **never reported** — not that everything is configured. The distinction
   * matters: ShareFlow decides this with `connector.isConfigured()`, a runtime environment read in its own
   * process, and a database row cannot stand in for it. Reporting `active` for an account whose platform has
   * no credentials is wrong, and so is reporting `not-configured` on a guess; the honest position without
   * this dependency is to report what the store knows and no more.
   */
  readonly configuredPlatforms?: (context: ExecutionContext) => Promise<readonly string[]> | readonly string[];
  /**
   * A live re-check against the platform, one call per account.
   *
   * Without it `checkHealth` **refuses** rather than returning the stored status. The tool's own description
   * is why: *"Re-check specific destinations against their platform, rather than reading the stored status."*
   * Answering from the store there would be a false claim the assistant then relays to a user — and the model
   * calls it exactly when the stored status is the thing under suspicion, after a publish has just failed.
   */
  readonly probe?: (input: {
    readonly context: ExecutionContext;
    readonly accountId: string;
    readonly platformId: string;
  }) => Promise<AccountHealth>;
  readonly now?: () => number;
};

export const createPostgresConnectorService = (deps: ConnectorDeps): ConnectorService => {
  const now = deps.now ?? Date.now;
  const { sql } = deps;

  /**
   * Health from the row, and **the expiry is checked as well as the status**.
   *
   * An account can sit at `ACTIVE` with `token_expires_at` in the past: the status is written by ShareFlow's
   * refresh route, which runs on its own schedule, so between expiry and the next refresh the two disagree.
   *
   * Reading only `status` would make `list_accounts` say "active" while a publish is refused for
   * `credential-expired` — the publishing adapter already derives it this way — which is two answers to one
   * question, and the assistant would report the reassuring one.
   */
  const healthOf = (row: AccountRow, configured: ReadonlySet<string> | undefined): AccountHealth => {
    if (configured !== undefined && !configured.has(row.platform)) return "not-configured";
    const stored = accountHealthFrom(row.status);
    /**
     * A lapsed token beats a stored `ACTIVE`, but **not** a stored `DISCONNECTED` or `EXPIRED`.
     *
     * Order matters here: `revoked` is more specific than `expired` and tells a user something different —
     * reconnect versus re-authorise — so an expiry check that ran first would flatten it away.
     */
    if (stored === "active" && row.token_expires_at !== null && Date.parse(iso(row.token_expires_at)) <= now()) {
      return "expired";
    }
    return stored;
  };

  const toAccount = (row: AccountRow, configured: ReadonlySet<string> | undefined): ConnectedAccount => ({
    id: row.id as never,
    platformId: row.platform as never,
    displayName: row.account_name,
    health: healthOf(row, configured),
    ...(row.token_expires_at === null ? {} : { accessExpiresAt: iso(row.token_expires_at) }),
    /**
     * `healthDetail` is deliberately **not set**.
     *
     * The port is explicit that it is free prose an adapter fills, that the obvious way to fill it is with the
     * provider's error message, and that a token ends up there. `tools/accounts.ts` does not propagate it, and
     * the agent-facing remediation is a stable code plus `getConnectionSetup`'s structured payload. Writing
     * one here would be adding a field whose only consumer is a UI this package does not own.
     */
  });

  const configuredSet = async (context: ExecutionContext): Promise<ReadonlySet<string> | undefined> => {
    if (deps.configuredPlatforms === undefined) return undefined;
    return new Set(await deps.configuredPlatforms(context));
  };

  return {
    async listAccounts(context): Promise<readonly ConnectedAccount[]> {
      const configured = await configuredSet(context);
      const rows = await sql.query<AccountRow>(
        `${ACCOUNT_COLUMNS} where workspace_id = $1::uuid order by platform asc, account_name asc`,
        [String(context.tenantId)],
      );
      return rows.map((row) => toAccount(row, configured));
    },

    async checkHealth(context, input): Promise<readonly ConnectedAccount[]> {
      const ids = input.accountIds.map((id) => asUuid("accountId", String(id)));
      const rows = await sql.query<AccountRow>(
        `${ACCOUNT_COLUMNS} where workspace_id = $1::uuid and id = any($2::uuid[])`,
        [String(context.tenantId), ids],
      );

      /**
       * Every id must resolve, and a missing one is `not_found` for the whole call.
       *
       * Returning the accounts that did resolve and dropping the rest would have the assistant report on a
       * subset while believing it asked about all of them — and the id it silently dropped is the one the user
       * asked about, because that is why it is being re-checked.
       */
      if (rows.length !== ids.length) {
        const found = new Set(rows.map((row) => row.id));
        const missing = ids.filter((id) => !found.has(id));
        throw new AgentPlatformError({
          code: "not_found",
          // Absent or another tenant's — indistinguishable on purpose, as everywhere else here.
          message: `No connected account ${missing.join(", ")} in this workspace.`,
          retryable: false,
        });
      }

      if (deps.probe === undefined) {
        /**
         * Refused, not answered from the store — and this is the one place in these adapters where refusing
         * beats returning what is known.
         *
         * `getPerformanceBrief` and `getClaimPolicy` answer empty because "nothing to say" is a truthful
         * answer to their question. This method's question is *"what does the platform say right now"*, and
         * the stored status is precisely what the caller is declining to trust: the model reaches for this
         * after a publish has failed. Answering `ACTIVE` from a row would be a false claim relayed to a user
         * as a live check.
         *
         * It does not break a turn — a tool refusal is a result the model can act on, and the message names
         * the capability that does work.
         */
        throw new AgentPlatformError({
          code: "capability_unavailable",
          message:
            "This deployment cannot re-check a destination against its platform: no connector probe is " +
            "wired, and the stored status is not a live check. Use `list_accounts` for the stored status, " +
            "and reconnect the account in the app if a publish is failing.",
          retryable: false,
        });
      }

      const configured = await configuredSet(context);
      const probe = deps.probe;
      return Promise.all(
        rows.map(async (row) => {
          const base = toAccount(row, configured);
          /**
           * A probe failure is `expired`, not a thrown call.
           *
           * One unreachable platform must not lose the answer for the others — and "we could not reach the
           * platform" is much closer to "this destination may not work" than to "this destination is fine".
           */
          const health = await probe({ context, accountId: row.id, platformId: row.platform }).catch(
            () => "expired" as AccountHealth,
          );
          return { ...base, health };
        }),
      );
    },

    async getConnectionSetup(context): Promise<ConnectionSetup> {
      // Straight from the deployment. Nothing here is derivable from a row — see `ConnectorDeps.setup`.
      return deps.setup(context);
    },
  };
};
