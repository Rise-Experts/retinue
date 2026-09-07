/**
 * `LeadService` over `leads` — REQ-041 (#190).
 *
 * Two findings, and both came from reading the constraints and indexes rather than the port:
 *
 * 1. **`rejected` is not a status this column can hold.** `LEAD_STATUSES` is
 *    `new | contacted | qualified | rejected`; `leads_status_check` is `ARRAY['new', 'contacted',
 *    'qualified']`. A patch setting `rejected` would fail at the constraint with a violation string a model
 *    cannot act on, so it is refused here, by name, with the three that work.
 * 2. **The dedupe the port wants is already enforced by the database**, which is the opposite of
 *    `scheduled_items`. Two partial unique indexes do it:
 *
 *    ```
 *    leads_dedupe_email_idx        (workspace_id, lower(email))          WHERE email IS NOT NULL
 *    leads_dedupe_name_source_idx  (workspace_id, name, captured_from)   WHERE email IS NULL AND captured_from IS NOT NULL
 *    ```
 *
 *    So `existing` is decided by `ON CONFLICT DO NOTHING` in one statement — atomic, with no lock and no
 *    read-then-write. Worth stating next to the publishing adapter's row lock: the difference between the two
 *    is not a difference in care, it is that one table has the index and the other does not.
 *
 * ## Suppression has nothing behind it, and that is reported rather than implied
 *
 * `LeadCreateResult` has a `suppressed` arm and `LEAD_SUPPRESSION_REASONS` has four values. There is **no
 * suppression table in this schema and no suppression path in ShareFlow** — the port describes it as
 * *"enforced inside the insert path"*, and that path does not exist here.
 *
 * The arm is not dropped, because the risk the port names is real: *"the risk is not that a tool bypasses it,
 * but that a tool **misreports** it: telling the user a lead was captured for someone who opted out."* So a
 * deployment that has a suppression list supplies `isSuppressed`, and without one `LEAD_SUPPRESSION` on this
 * module says plainly that no lead is ever suppressed — which a caller can check rather than infer from never
 * seeing the outcome.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

import {
  LEAD_STATUSES,
  type Lead,
  type LeadAttribution,
  type LeadCreateResult,
  type LeadService,
  type LeadStatus,
  type LeadSuppressionReason,
  type Page,
} from "../../services/index.js";

/**
 * The statuses the column admits, from `leads_status_check`.
 *
 * `rejected` is in the port's union and **not** here. Left out rather than mapped onto something else: a
 * `rejected` lead silently stored as `contacted` would tell a salesperson to follow up on someone who was
 * turned down.
 */
export const STORED_LEAD_STATUSES = ["new", "contacted", "qualified"] as const;

/** Whether this deployment can suppress a lead at all. Declared, so a caller can ask instead of inferring. */
export const LEAD_SUPPRESSION = {
  /** False unless a deployment supplies `isSuppressed` — no table in this schema holds opt-outs. */
  enforced: false,
} as const;

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

const asCursor = (value: string): string => {
  if (!Number.isFinite(Date.parse(value))) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        `cursor must be one this endpoint returned — got ${JSON.stringify(value.slice(0, 60))}. ` +
        "Pass `nextCursor` from a previous page, or omit it to start from the beginning.",
      retryable: false,
    });
  }
  return value;
};

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const assertStorableStatus = (status: LeadStatus): string => {
  if (!(STORED_LEAD_STATUSES as readonly string[]).includes(status)) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        `This deployment cannot store the status "${status}" — \`leads_status_check\` admits ` +
        `${STORED_LEAD_STATUSES.join(", ")}. Left to the constraint this would come back as a violation ` +
        "naming the constraint rather than the values you may use.",
      retryable: false,
    });
  }
  return status;
};

/**
 * `platform` is `NOT NULL` with a CHECK, and the port's attribution makes it optional.
 *
 * `bio` is in `leads_platform_check` alongside the eleven networks and is the one value that does not mean "a
 * social network" — it is ShareFlow's own link-in-bio page. So it is what an attribution with no platform
 * becomes: a lead captured through the workspace's own surface rather than a guessed network.
 */
export const DEFAULT_LEAD_PLATFORM = "bio";

/**
 * The attribution, serialised into `captured_from`.
 *
 * The port says to: *"The adapter serialises into `capturedFrom` until ShareFlow has columns for it, which is
 * the schema change this implies."*
 *
 * A `key=value` encoding rather than JSON, and **determinism is the requirement** — the column is part of
 * `leads_dedupe_name_source_idx` (`workspace_id, name, captured_from`), so its exact text decides whether two
 * leads are the same lead. `JSON.stringify` does not guarantee key order across object shapes, so one
 * attribution could encode two ways and defeat the dedupe.
 *
 * The determinism here comes from the **fixed order of these four lines**, not from a sort. A first version
 * also called `.sort()` and claimed that was what made it stable; sabotage removed the sort and nothing
 * failed, because a list built in a fixed order is already stable. The sort is gone and the guarantee is
 * where it actually lives.
 */
export const encodeAttribution = (attribution: LeadAttribution): string | null => {
  // Fixed order. Adding a field means adding a line here, which is the point: the position is the contract.
  const parts = [
    attribution.postDraftId === undefined ? undefined : `post=${String(attribution.postDraftId)}`,
    attribution.campaignId === undefined ? undefined : `campaign=${String(attribution.campaignId)}`,
    attribution.commentId === undefined ? undefined : `comment=${String(attribution.commentId)}`,
    attribution.platformId === undefined ? undefined : `platform=${String(attribution.platformId)}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? null : parts.join(";");
};

export const decodeAttribution = (capturedFrom: string | null, platform: string | null): LeadAttribution => {
  const found = new Map<string, string>();
  for (const part of (capturedFrom ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) found.set(part.slice(0, at), part.slice(at + 1));
  }
  const post = found.get("post");
  const campaign = found.get("campaign");
  const comment = found.get("comment");
  /**
   * `platform` comes from the column, not the encoded string, when the two disagree.
   *
   * The column is the one the store indexes and constrains; the encoded copy exists only because
   * `captured_from` had to carry the rest. Preferring the column means a lead whose `captured_from` was
   * written by ShareFlow's own UI — free text, no encoding — still reports its platform correctly.
   */
  const platformId = platform ?? found.get("platform");
  return {
    ...(post === undefined ? {} : { postDraftId: post as never }),
    ...(campaign === undefined ? {} : { campaignId: campaign as never }),
    ...(comment === undefined ? {} : { commentId: comment as never }),
    ...(platformId === undefined || platformId === DEFAULT_LEAD_PLATFORM ? {} : { platformId: platformId as never }),
  };
};

/** How many leads a page returns. A tool result enters the context window. */
export const MAX_LEAD_LIMIT = 50;

type LeadRow = {
  id: string;
  name: string;
  email: string | null;
  platform: string | null;
  captured_from: string | null;
  value_cents: number | null;
  status: string | null;
  created_at: string | Date;
};

const LEAD_COLUMNS = `select id, name, email, platform, captured_from, value_cents, status, created_at
                        from public.leads`;

/**
 * An unrecognised stored status reads as `new`, the reading that invites work rather than assuming it is done.
 *
 * Unreachable through a row while the CHECK constraint holds — the three it admits are all mapped — so this
 * exists for a future migration, the same as the connector adapter's arm.
 */
export const leadStatusFrom = (value: string | null): LeadStatus =>
  (LEAD_STATUSES as readonly string[]).includes(String(value)) ? (value as LeadStatus) : "new";

const toLead = (row: LeadRow): Lead => ({
  id: row.id as never,
  name: row.name,
  ...(row.email === null ? {} : { email: row.email }),
  status: leadStatusFrom(row.status),
  ...(row.value_cents === null ? {} : { valueMinorUnits: row.value_cents }),
  attribution: decodeAttribution(row.captured_from, row.platform),
  createdAt: iso(row.created_at),
});

export type LeadDeps = {
  readonly sql: SqlExecutor;
  /**
   * Whether this address must never be added. Absent means **no lead is ever suppressed**.
   *
   * Not a default of "nothing is suppressed" pretending to be a check: `LEAD_SUPPRESSION.enforced` says which
   * it is, because the failure the port cares about is *misreporting* — telling a user a lead was captured for
   * someone who opted out. A caller that needs the guarantee can see it is absent instead of concluding from
   * never seeing the outcome that nobody has opted out.
   */
  readonly isSuppressed?: (input: {
    readonly context: ExecutionContext;
    readonly email?: string;
    readonly name: string;
  }) => Promise<LeadSuppressionReason | undefined>;
};

/**
 * Email normalisation, in one place, because suppression matching depends on it.
 *
 * The port: *"a second normaliser here would eventually disagree about what matches — which for an opt-out
 * means contacting someone who asked not to be."* Lower-cased and trimmed, matching
 * `leads_dedupe_email_idx`'s `lower((email)::text)` exactly — anything more aggressive (stripping dots, `+`
 * tags) would make this adapter dedupe on a rule the index does not, so two addresses it called the same
 * would both insert.
 */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

export const createPostgresLeadService = (deps: LeadDeps): LeadService => {
  const { sql } = deps;

  return {
    async listLeads(context, input): Promise<Page<Lead>> {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_LEAD_LIMIT);
      const rows = await sql.query<LeadRow>(
        `${LEAD_COLUMNS}
          where workspace_id = $1::uuid
            and ($2::text is null or status = $2::text)
            and ($3::timestamptz is null or created_at < $3::timestamptz)
          order by created_at desc
          limit $4`,
        [
          String(context.tenantId),
          input.status === undefined ? null : assertStorableStatus(input.status),
          input.cursor === undefined ? null : asCursor(input.cursor),
          limit + 1,
        ],
      );
      const page = rows.slice(0, limit);
      const items = page.map(toLead);
      return rows.length > limit && page.length > 0
        ? { items, nextCursor: iso(page[page.length - 1]!.created_at) }
        : { items };
    },

    async createLead(context, input): Promise<LeadCreateResult> {
      if (input.name.trim() === "") {
        throw new AgentPlatformError({ code: "invalid_input", message: "A lead needs a name.", retryable: false });
      }
      const email = input.email === undefined ? undefined : normaliseEmail(input.email);

      /**
       * Suppression is checked **before** the insert, when a deployment can check it at all.
       *
       * First rather than after the dedupe, because an opt-out is a stronger answer than "already here": a
       * lead that exists *and* has opted out must be reported as suppressed, not as an ordinary duplicate.
       */
      if (deps.isSuppressed !== undefined) {
        const reason = await deps.isSuppressed({
          context,
          ...(email === undefined ? {} : { email }),
          name: input.name,
        });
        if (reason !== undefined) return { outcome: "suppressed", reason };
      }

      const capturedFrom = encodeAttribution(input.attribution);
      const platform = input.attribution.platformId ?? DEFAULT_LEAD_PLATFORM;

      /**
       * **`ON CONFLICT DO NOTHING`, and the database decides.**
       *
       * Two partial unique indexes hold the dedupe — `(workspace_id, lower(email))` when there is an email and
       * `(workspace_id, name, captured_from)` when there is not — so one statement is atomic and needs no
       * lock. That is the opposite of `scheduled_items`, which has no such index and needs a row lock for the
       * same guarantee; the difference is the index, not the care taken.
       *
       * `DO NOTHING` rather than `DO UPDATE`: a second sighting of a lead must not overwrite what a
       * salesperson has since edited. The `existing` arm returns the stored row, which is what the caller
       * needs to see.
       */
      const inserted = await sql.query<LeadRow>(
        `insert into public.leads (workspace_id, name, email, platform, captured_from, value_cents, status)
         values ($1::uuid, $2, $3, $4, $5, $6, 'new')
         on conflict do nothing
         returning id, name, email, platform, captured_from, value_cents, status, created_at`,
        [
          String(context.tenantId),
          input.name.trim(),
          email ?? null,
          platform,
          capturedFrom,
          // `value_cents` is NOT NULL and the port's field is optional. Zero is the truthful default here: an
          // unvalued lead is worth nothing *recorded*, and the column cannot hold "unknown".
          input.valueMinorUnits ?? 0,
        ],
      );

      const created = inserted[0];
      if (created !== undefined) return { outcome: "created", lead: toLead(created) };

      /**
       * Nothing inserted means an index matched. Read back the one it matched, on the same rule.
       *
       * Reported as `existing` and never as `created`, because the port is explicit that *"a dedupe match
       * reported as `created` is the same class of untruth"* as misreporting a suppression.
       */
      const existing = await sql.query<LeadRow>(
        email === undefined
          ? `${LEAD_COLUMNS} where workspace_id = $1::uuid and email is null and name = $2 and captured_from = $3`
          : `${LEAD_COLUMNS} where workspace_id = $1::uuid and lower(email) = $2`,
        email === undefined
          ? [String(context.tenantId), input.name.trim(), capturedFrom]
          : [String(context.tenantId), email],
      );
      const match = existing[0];
      if (match === undefined) {
        /**
         * A conflict with nothing to show for it.
         *
         * Reachable if a row was deleted between the insert and this read, and reported as `internal` rather
         * than invented as `created`: the caller asked whether a lead was added and the honest answer is that
         * this call cannot tell.
         */
        throw new AgentPlatformError({
          code: "internal",
          message: "The lead was neither added nor found; try again.",
          retryable: true,
        });
      }
      return { outcome: "existing", lead: toLead(match) };
    },

    async updateLead(context, input): Promise<Lead> {
      const id = asUuid("id", String(input.id));
      const status = input.patch.status === undefined ? null : assertStorableStatus(input.patch.status);
      const email = input.patch.email === undefined ? null : normaliseEmail(input.patch.email);

      const rows = await sql.query<LeadRow>(
        `update public.leads set
            name = coalesce($3, name),
            email = coalesce($4, email),
            status = coalesce($5, status),
            value_cents = coalesce($6, value_cents),
            updated_at = now()
          where workspace_id = $1::uuid and id = $2::uuid
          returning id, name, email, platform, captured_from, value_cents, status, created_at`,
        [
          String(context.tenantId),
          id,
          input.patch.name ?? null,
          email,
          status,
          input.patch.valueMinorUnits ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        // `not_found`, never `forbidden` — absent and another tenant's must be indistinguishable.
        throw new AgentPlatformError({ code: "not_found", message: `No lead ${id}.`, retryable: false });
      }
      return toLead(row);
    },
  };
};
