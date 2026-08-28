/**
 * The GitHub transport — REQ-051 (#222), task #223.
 *
 * Extracted from `index.ts` when the toolkit went from 6 tools to 44: four groups of tools sharing one
 * credential path, one pagination rule and one error vocabulary. Nothing here knows what a tool is.
 *
 * The GraphQL half is the new part, and it exists because Projects v2 has no REST API at all.
 */

import {
  createHttpClient,
  credentialHeader,
  type CredentialRef,
  type CredentialResolver,
  type HttpOutcome,
} from "@retinue/agentkit/tools";
import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";

export const API = "https://api.github.com";

/** GitHub's own cap. Asking for more silently returns 100, which reads as "there were only 100". */
export const MAX_PER_PAGE = 100;
export const DEFAULT_PER_PAGE = 30;
/** A ceiling on pagination, so one call cannot walk an entire repository's history. */
export const MAX_PAGES = 5;

export type Json = Record<string, unknown>;

export type TransportConfig = {
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
};

/**
 * A failed HTTP outcome, turned into something a model can act on.
 *
 * **429 and 403-with-a-reset are rate limits, not errors**, and saying so matters: a model told "forbidden"
 * retries with different arguments, which is wrong. Told "rate limited", it waits or stops. GitHub signals its
 * limit as 403 with `x-ratelimit-remaining: 0`, which is the detail everybody misses.
 *
 * `AgentPlatformError`, not a decorated `Error`: `toPlatformError` maps anything else to `{ code: "internal",
 * retryable: false }`, so a rate limit thrown as `Object.assign(new Error(…), { retryable: true })` arrives at
 * the model as permanent. The extra properties simply vanish and nothing warns you.
 *
 * The codes come from the platform's closed union, not from a word that reads well — `upstream_error` was the
 * obvious name and is not a code. Caught by `tsc -b` and *not* by the tests, because vitest transpiles without
 * typechecking.
 */
export const describeFailure = (outcome: Extract<HttpOutcome, { ok: false }>): never => {
  const rateLimited = outcome.status === 429 || /rate limit/i.test(outcome.reason);
  const unauthorized = outcome.status === 401 || outcome.status === 403;
  const transport = outcome.kind === "timeout" || outcome.kind === "unreachable";
  throw new AgentPlatformError({
    code: rateLimited
      ? "rate_limited"
      : // 401/403 without a rate-limit signal is a scope problem, and it is the single most common way a
        // GitHub tool fails: a token that reads code cannot write a project. Saying `unauthorized` rather than
        // `provider_error` is what stops the model retrying — AC-6.
        unauthorized && !transport
        ? "unauthorized"
        : transport
          ? "provider_unavailable"
          : "provider_error",
    message: rateLimited
      ? `GitHub rate limit reached: ${outcome.reason}`
      : unauthorized && !transport
        ? `GitHub refused the credential (${outcome.status}): ${outcome.reason}. The token may lack the scope this tool needs.`
        : `GitHub request failed (${outcome.kind}): ${outcome.reason}`,
    retryable: rateLimited || transport,
  });
};

/**
 * JSON, except when there is none.
 *
 * **204 and 201-with-no-content are successes.** `github_dispatch_workflow` gets a 204 and `github_rerun_workflow`
 * a 201, both with an empty body — and `JSON.parse("")` throws, so both tools failed outright while reporting a
 * parse error about a response that was correct. Found by the tests, not by reading: every write in this
 * toolkit returns a body except the two that do not.
 */
const parse = (body: string): unknown => {
  if (body.trim() === "") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("GitHub returned a body that is not JSON");
  }
};

export type Transport = {
  readonly call: (context: ExecutionContext, path: string, init?: { method?: string; body?: Json }) => Promise<unknown>;
  /**
   * The response body verbatim, for the endpoints that do not answer in JSON.
   *
   * Only workflow logs, today. Its absence was not a gap in the transport — it was a *bug in the log tool*,
   * which called `call`, caught the "not JSON" failure, and returned a placeholder object. The log text was
   * discarded and the tool returned `{"__raw":true}` on every success. It typechecked, and the test that asked
   * for a known string back is what found it.
   */
  readonly text: (context: ExecutionContext, path: string) => Promise<string>;
  readonly paginate: (
    context: ExecutionContext,
    path: string,
    perPage: number,
  ) => Promise<{ items: unknown[]; truncated: boolean }>;
  readonly graphql: <T = Json>(
    context: ExecutionContext,
    query: string,
    variables: Json,
    options?: { readonly tolerateNotFound?: boolean },
  ) => Promise<T>;
};

export const createTransport = (config: TransportConfig): Transport => {
  const base = (config.baseUrl ?? API).replace(/\/$/, "");
  const host = new URL(base).host;

  /**
   * One request, with the credential resolved now rather than at construction.
   *
   * Per call so a rotated token takes effect without a restart — a credential read once at startup is one that
   * survives its own rotation, and the failure looks like the vendor rejecting a token that "has not changed".
   *
   * The header goes in through `headersFor`, which the runtime calls with the *validated* hostname only: a
   * token issued for `api.github.com` cannot be sent elsewhere by asking for a URL that merely mentions it.
   */
  const request = async (
    context: ExecutionContext,
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<string> => {
    const credential = await config.resolver.resolve({ ref: config.credentialRef, context });
    // One helper, so twenty toolkits do not each write their own base64 and get the padding wrong — #260.
    const [headerName, headerValue] = credentialHeader(credential);
    const client = createHttpClient({
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      headersFor: (requested) =>
        requested === host
          ? {
              [headerName.toLowerCase()]: headerValue,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
            }
          : undefined,
    });
    const outcome = await client.request({
      url: `${base}${path}`,
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(init.body === undefined ? {} : { body: init.body }),
      // Parsed here and never shown to the model verbatim, so the untrusted-content envelope would only corrupt
      // the JSON. Anything rendered as prose keeps the default fence.
      fence: false,
    });
    if (!outcome.ok) describeFailure(outcome);
    return (outcome as Extract<HttpOutcome, { ok: true }>).body;
  };

  const call: Transport["call"] = async (context, path, init = {}) =>
    parse(
      await request(context, path, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );

  /**
   * Every page up to a ceiling, and **it says when it stopped**.
   *
   * A tool that returns page one and says nothing about page two loses data silently: the model concludes there
   * were thirty issues. The ceiling exists because "all of them" against a large repository is a call that
   * never returns, and reporting `truncated` is what keeps the difference visible.
   */
  const text: Transport["text"] = (context, path) => request(context, path);

  const paginate: Transport["paginate"] = async (context, path, perPage) => {
    const size = Math.min(Math.max(perPage, 1), MAX_PER_PAGE);
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = await call(context, `${path}${separator}per_page=${size}&page=${page}`);
      const rows = Array.isArray(batch) ? batch : [];
      items.push(...rows);
      if (rows.length < size) return { items, truncated: false };
    }
    return { items, truncated: true };
  };

  /**
   * GraphQL, and **the envelope is read** — AC-4.
   *
   * GraphQL answers `200 OK` with `{ "data": null, "errors": [...] }`. Every HTTP-level check passes, `ok` is
   * true, and a transport that stops there hands the tool a `data` of `null` and reports success. The tool then
   * reads `data.organization.projectV2` off `null`, throws a `TypeError`, and the model is told "internal
   * error" about a problem that was described precisely in a field nobody looked at.
   *
   * Exactly Slack's `ok: false` lesson (#214), which is why this is a transport concern and not a per-tool one:
   * six Projects tools would each have had to remember.
   *
   * `data` absent or null with no `errors` is also a failure. A successful GraphQL response always carries
   * `data`, so that shape means something changed and guessing would report a wrong answer as a right one.
   */
  const graphql: Transport["graphql"] = async <T = Json>(
    context: ExecutionContext,
    query: string,
    variables: Json,
    options: { readonly tolerateNotFound?: boolean } = {},
  ): Promise<T> => {
    const body = await request(context, "/graphql", { method: "POST", body: JSON.stringify({ query, variables }) });
    const envelope = parse(body) as { data?: unknown; errors?: unknown };
    /**
     * `tolerateNotFound` exists for exactly one shape: a query that asks two ways at once.
     *
     * A GitHub login is an organisation *or* a user, and Projects v2 hangs off both. Asking the caller which is
     * pushing an implementation detail into the schema, which is the thing Group C exists not to do. So the
     * query asks for both and GitHub answers `data: { organization: null, user: {…} }` with a `NOT_FOUND` in
     * `errors` for the half that does not exist.
     *
     * Narrow on purpose: only `NOT_FOUND`, only when the caller opted in, and only when *some* data came back.
     * A query where every alias missed still fails, so this cannot turn a wrong login into an empty answer.
     */
    const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
    const survivable =
      options.tolerateNotFound === true &&
      errors.length > 0 &&
      errors.every((error) => (error as { type?: unknown }).type === "NOT_FOUND") &&
      envelope.data !== null &&
      typeof envelope.data === "object" &&
      Object.values(envelope.data as Json).some((value) => value !== null);
    if (survivable) return envelope.data as T;
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      const first = envelope.errors[0] as { message?: unknown; type?: unknown };
      const message = typeof first.message === "string" ? first.message : "GitHub GraphQL returned an error";
      const type = typeof first.type === "string" ? first.type : undefined;
      throw new AgentPlatformError({
        // `NOT_FOUND` and `FORBIDDEN` arrive here rather than as an HTTP status, so the distinction the model
        // needs — is retrying pointless — is only in the envelope.
        code: type === "FORBIDDEN" || type === "INSUFFICIENT_SCOPES" ? "unauthorized" : "provider_error",
        message:
          envelope.errors.length > 1
            ? `${message} (and ${envelope.errors.length - 1} more GraphQL error(s))`
            : message,
        retryable: false,
      });
    }
    if (envelope.data === undefined || envelope.data === null) {
      throw new AgentPlatformError({
        code: "provider_error",
        message: "GitHub GraphQL returned no data and no errors, which is not a shape this understands",
        retryable: false,
      });
    }
    return envelope.data as T;
  };

  return { call, text, paginate, graphql };
};
