/**
 * `LinkService` over `short_links` and `link_clicks` — #424.
 *
 * Both tables were live and invisible to the agent. The web app creates links and `/l/{slug}` records
 * a click; the assistant had no tool against either, so it could answer "how did this post reach" and
 * not "did it drive anything".
 *
 * Three things about this schema decide the shape of what follows:
 *
 * 1. **Attribution did not exist.** `short_links` had `slug`, `destination_url`, `title` and nothing
 *    linking a link to a post. `20260914090000_short_link_attribution.sql` adds `post_id` and
 *    `campaign_id`, nullable and `on delete set null` — a short link is a URL in the world, and it must
 *    keep redirecting when the post it advertised is deleted.
 *
 * 2. **`link_clicks` has no workspace column.** It reaches one only through `short_links`, so every
 *    query here joins rather than filters, and the tenant check lives on the join. A click table scoped
 *    by a column that is not there is the kind of mistake that reads another tenant's numbers.
 *
 * 3. **The origin is the deployment's, not the row's.** `short_links` stores a slug; the full URL is
 *    `{PUBLIC_APP_URL}/l/{slug}`. Storing the origin per row would mean a deployment that changes
 *    domain serves dead links out of its own database.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

import type {
  CampaignId,
  LinkId,
  LinkPerformance,
  LinkService,
  PostDraftId,
  TrackedLink,
} from "../../services/index.js";

/**
 * The slug alphabet and length ShareFlow's own `randomSlug` uses.
 *
 * Replicated rather than imported for the reason `SWEEP_GRACE_MS` is: nothing in this package can call
 * across the repository boundary, and a slug minted here has to be indistinguishable from one the web
 * app minted — they share a unique index and a public URL space.
 *
 * No vowels and no look-alikes, so a slug cannot spell something and cannot be misread aloud.
 */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 7;

/** Attempts before giving up on a unique slug. The web app uses five; a collision needs two of 31^7. */
const SLUG_ATTEMPTS = 5;

const randomSlug = (random: () => number): string => {
  let out = "";
  for (let i = 0; i < SLUG_LENGTH; i += 1) out += SLUG_ALPHABET[Math.floor(random() * SLUG_ALPHABET.length)];
  return out;
};

/**
 * The destination, normalised the way the web app normalises it.
 *
 * A bare `northwind.studio` becomes `https://northwind.studio/`, because a model asked for a link to a
 * site will write the domain. Anything that is not http(s) after that is refused: a `javascript:` or
 * `data:` destination behind a short link on the workspace's own domain is a redirect the workspace
 * did not intend to offer.
 */
export const normaliseDestination = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

export type LinkDeps = {
  readonly sql: SqlExecutor;
  /** `PUBLIC_APP_URL` — where `/l/{slug}` is served from. */
  readonly publicAppUrl: string;
  /** Injected so a test can assert a slug instead of guessing it. */
  readonly random?: () => number;
};

type LinkRow = {
  id: string;
  slug: string;
  destination_url: string;
  title: string | null;
  created_at: Date | string;
  post_id: string | null;
  campaign_id: string | null;
  clicks: string | number | null;
};

const optional = <T extends string>(value: string | null): T | undefined =>
  value === null || value === "" ? undefined : (value as T);

const viewOf = (row: LinkRow, origin: string): TrackedLink => ({
  id: row.id as LinkId,
  slug: row.slug,
  url: `${origin.replace(/\/+$/, "")}/l/${row.slug}`,
  destinationUrl: row.destination_url,
  ...(row.title === null || row.title === "" ? {} : { title: row.title }),
  createdAt: new Date(row.created_at).toISOString(),
  clicks: Number(row.clicks ?? 0),
  ...(row.post_id === null ? {} : { postId: row.post_id as PostDraftId }),
  ...(row.campaign_id === null ? {} : { campaignId: row.campaign_id as CampaignId }),
});

export const createPostgresLinkService = (deps: LinkDeps): LinkService => {
  const random = deps.random ?? Math.random;

  /**
   * Refused by name when the deployment has no public origin.
   *
   * A short link is `{origin}/l/{slug}`, and without the origin there is nothing to hand anyone. The
   * alternative — minting the row anyway and returning a relative path — produces a link that is
   * stored, put in a post, published, and redirects nowhere.
   */
  const origin = (): string => {
    if (deps.publicAppUrl.trim() === "") {
      throw new AgentPlatformError({
        code: "capability_unavailable",
        message:
          "This deployment cannot build short links: PUBLIC_APP_URL is not set, so there is no origin " +
          "to put in front of /l/{slug}. Set it, or share the destination URL directly.",
        retryable: false,
      });
    }
    return deps.publicAppUrl;
  };

  return {
    async listTrackedLinks(context, input): Promise<readonly TrackedLink[]> {
      const rows = await deps.sql.query<LinkRow>(
        `select l.id, l.slug, l.destination_url, l.title, l.created_at, l.post_id, l.campaign_id,
                (select count(*) from public.link_clicks c where c.short_link_id = l.id) as clicks
           from public.short_links l
          where l.workspace_id = $1::uuid
            and ($2::uuid is null or l.post_id = $2::uuid)
            and ($3::uuid is null or l.campaign_id = $3::uuid)
          order by l.created_at desc
          limit $4::int`,
        [String(context.tenantId), input.postId ?? null, input.campaignId ?? null, input.limit],
      );
      return rows.map((row) => viewOf(row, origin()));
    },

    async getLinkPerformance(context, input): Promise<readonly LinkPerformance[]> {
      /*
       * One query for the totals, one for each dimension — rather than three left joins, which would
       * multiply the click rows by referrer and country and report every number several times over.
       * That is the classic fan-out bug in exactly this shape of query.
       */
      const totals = await deps.sql.query<LinkRow & { window_clicks: string | number }>(
        `select l.id, l.slug, l.destination_url, l.title, l.created_at, l.post_id, l.campaign_id,
                count(c.id) as window_clicks,
                count(c.id) as clicks
           from public.short_links l
           left join public.link_clicks c
             on c.short_link_id = l.id
            and c.clicked_at >= $2::timestamptz
            and ($3::timestamptz is null or c.clicked_at < $3::timestamptz)
          where l.workspace_id = $1::uuid
            and ($4::uuid is null or l.id = $4::uuid)
            and ($5::uuid is null or l.post_id = $5::uuid)
            and ($6::uuid is null or l.campaign_id = $6::uuid)
          group by l.id
          order by count(c.id) desc, l.created_at desc
          limit $7::int`,
        [
          String(context.tenantId),
          input.since,
          input.until ?? null,
          input.linkId ?? null,
          input.postId ?? null,
          input.campaignId ?? null,
          input.limit,
        ],
      );
      if (totals.length === 0) return [];

      const ids = totals.map((row) => row.id);
      const dimension = async (column: "referrer" | "country", fallback: string) =>
        deps.sql.query<{ short_link_id: string; value: string | null; clicks: string | number }>(
          `select c.short_link_id, coalesce(nullif(c.${column}, ''), $4::text) as value, count(*) as clicks
             from public.link_clicks c
            where c.short_link_id = any($1::uuid[])
              and c.clicked_at >= $2::timestamptz
              and ($3::timestamptz is null or c.clicked_at < $3::timestamptz)
            group by c.short_link_id, value
            order by count(*) desc`,
          [ids, input.since, input.until ?? null, fallback],
        );

      const [referrers, countries] = await Promise.all([
        // "direct" rather than "unknown": a click with no referrer is a person typing or tapping the
        // link, which is a fact about how it was used, not a gap in the data.
        dimension("referrer", "direct"),
        dimension("country", "unknown"),
      ]);

      const group = (
        rows: { short_link_id: string; value: string | null; clicks: string | number }[],
        id: string,
      ) => rows.filter((r) => r.short_link_id === id).map((r) => ({ value: r.value ?? "", clicks: Number(r.clicks) }));

      return totals.map((row) => ({
        linkId: row.id as LinkId,
        slug: row.slug,
        ...(row.title === null || row.title === "" ? {} : { title: row.title }),
        destinationUrl: row.destination_url,
        ...(row.post_id === null ? {} : { postId: row.post_id as PostDraftId }),
        ...(row.campaign_id === null ? {} : { campaignId: row.campaign_id as CampaignId }),
        clicks: Number(row.window_clicks ?? 0),
        referrers: group(referrers, row.id).map((r) => ({ referrer: r.value, clicks: r.clicks })),
        countries: group(countries, row.id).map((r) => ({ country: r.value, clicks: r.clicks })),
      }));
    },

    async createTrackedLink(context, input): Promise<TrackedLink> {
      // Checked first: a row minted for a link nobody can use is worse than a refusal.
      origin();
      const destination = normaliseDestination(input.destinationUrl);
      if (destination === null) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message:
            `"${input.destinationUrl}" is not a web address a link can point at. Give an http or https ` +
            "URL — a domain on its own is fine.",
          retryable: false,
        });
      }

      /*
       * Retried on the unique-slug collision, exactly as the web app's route does. 23505 is the only
       * error worth retrying: anything else is a real failure and a second attempt would hide it.
       */
      for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
        try {
          const rows = await deps.sql.query<LinkRow>(
            `insert into public.short_links
                    (workspace_id, slug, destination_url, title, created_by, post_id, campaign_id)
             values ($1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::uuid, $7::uuid)
             returning id, slug, destination_url, title, created_at, post_id, campaign_id, 0 as clicks`,
            [
              String(context.tenantId),
              randomSlug(random),
              destination,
              input.title ?? null,
              String(context.principalId),
              input.postId ?? null,
              input.campaignId ?? null,
            ],
          );
          const row = rows[0];
          if (row !== undefined) return viewOf(row, origin());
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code !== "23505") throw error;
        }
      }

      throw new AgentPlatformError({
        code: "conflict",
        message: `Could not mint a unique short link after ${SLUG_ATTEMPTS} attempts. Try again.`,
        retryable: true,
      });
    },
  };
};
