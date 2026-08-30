/**
 * The transport every sibling toolkit needs, once — REQ-052 (#224), task #225.
 *
 * `tools-github` grew one of these in #223 and it turned out to be four-fifths vendor-neutral: resolve the
 * credential *per call*, pin the auth header to one validated host, parse JSON with an empty body tolerated,
 * and map a failure onto the platform's closed error union. Only the last part is really vendor-specific, and
 * only in its wording.
 *
 * Writing it twice more for Jira and Confluence — with nineteen toolkits after them — would mean copying four
 * bugs along with it. #223 found two of them the hard way:
 *
 * - `JSON.parse("")` on a `204`. Two endpoints returned empty bodies on success and both tools failed outright
 *   while reporting a parse error about a correct response.
 * - A plain-text body handled by catching the parse failure, which discarded the text and returned a
 *   placeholder. The tool typechecked and was entirely non-functional.
 *
 * Both are fixed here, so a toolkit gets them right by not writing them.
 *
 * **What stays with the vendor**: the failure vocabulary (`classify`), the base URL, and the fixed headers.
 * A vendor that answers `200` with an error envelope — Slack's `ok: false`, GraphQL's `errors` — reads that
 * envelope in its own module, because only it knows the shape.
 */

import type { ExecutionContext } from "../core/context.js";
import { AgentPlatformError, type PlatformError } from "../core/errors.js";
import type { CredentialRef, CredentialResolver } from "../tools/credentials.js";
import { credentialHeader } from "../tools/credentials.js";
import { createHttpClient, type HttpOutcome } from "./http.js";

/** What a vendor's classifier is handed: the failed outcome, already narrowed. */
export type VendorFailure = Extract<HttpOutcome, { ok: false }>;

/**
 * How this vendor names its failures.
 *
 * Returning `undefined` accepts the default, which is deliberately conservative: a transport failure is
 * `provider_unavailable` and retryable, `401`/`403` is `unauthorized` and not, and everything else is
 * `provider_error` and not. A vendor overrides where its own signalling differs — GitHub reports a rate limit
 * as `403` with a header, which no default could guess.
 */
/**
 * `PlatformError["code"]`, not a hand-picked subset.
 *
 * The first version listed four codes — the ones the default classification uses — and Jira needed a fifth the
 * same afternoon: `409`/`412` is a `conflict`, which is a real platform code and was not on the list. Naming a
 * subset means guessing which codes vendors will need, and the platform union is already the right constraint.
 */
/**
 * `retryAfterMs` is part of the return type, and its absence was a live bug.
 *
 * The default 429 arm below has always *set* it — inside an object typed as `Pick<…, "code"|"message"|"retryable">`,
 * where a spread makes an excess property legal and unreadable. So the field was written, typechecked, and could
 * not be read by the one line that needed it. See the propagation note in `request`.
 */
export type VendorClassifier = (
  failure: VendorFailure,
) => Pick<PlatformError, "code" | "message" | "retryable" | "retryAfterMs"> | undefined;

export type VendorTransportConfig = {
  /** Resolved per call, by the host. A toolkit must never read the environment. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  /** No trailing slash needed; one is stripped. */
  readonly baseUrl: string;
  /** Sent on every request, alongside the resolved credential header. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The vendor's own name for what went wrong. */
  readonly classify?: VendorClassifier;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
  /** Named in every error message, so a failure says which integration produced it. */
  readonly vendor: string;
};

export type VendorTransport = {
  /** Parsed JSON, or `undefined` when the vendor answered with no body — a `204` is a success. */
  readonly json: (
    context: ExecutionContext,
    path: string,
    init?: { readonly method?: string; readonly body?: unknown },
  ) => Promise<unknown>;
  /** The body verbatim, for the endpoints that do not answer in JSON. */
  readonly text: (
    context: ExecutionContext,
    path: string,
    init?: {
      readonly method?: string;
      readonly body?: unknown;
      /**
       * Sent **as-is**, with `contentType`, instead of being JSON-encoded.
       *
       * For a media endpoint: Drive's `uploadType=media` wants the file's bytes, and `JSON.stringify` on a
       * string produces a quoted string — a file whose contents are a JSON literal, uploaded successfully.
       * Nothing errors, which is why this is a parameter rather than a caller's `JSON.parse` dance.
       */
      readonly rawBody?: string;
      readonly contentType?: string;
    },
  ) => Promise<string>;
};

/**
 * The default classification, and why each arm is what it is.
 *
 * A model reads these to decide whether trying again is sensible, so the distinction that matters is
 * *retryable*, not how precisely the words describe the HTTP status. `unauthorized` on a `403` is the important
 * one: told "forbidden", a model retries with different arguments, which is never the fix for a missing scope.
 */
const defaultClassification = (
  failure: VendorFailure,
  vendor: string,
): Pick<PlatformError, "code" | "message" | "retryable" | "retryAfterMs"> => {
  const transport = failure.kind === "timeout" || failure.kind === "unreachable";
  if (transport) {
    return {
      code: "provider_unavailable",
      message: `${vendor} request failed (${failure.kind}): ${failure.reason}`,
      retryable: true,
    };
  }
  if (failure.status === 429) {
    /**
     * `Retry-After` is honoured when the vendor sent one — the default backoff is a guess, and a vendor that
     * told you the number has removed the need to guess. Meta, X and Reddit all send it.
     */
    return {
      code: "rate_limited",
      message:
        `${vendor} rate limit reached: ${failure.reason}` +
        (failure.retryAfterMs === undefined ? "" : ` Retry after ${Math.ceil(failure.retryAfterMs / 1000)}s.`),
      retryable: true,
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    };
  }
  if (failure.status === 401 || failure.status === 403) {
    return {
      code: "unauthorized",
      message: `${vendor} refused the credential (${failure.status}): ${failure.reason}. The credential may lack the permission this tool needs.`,
      retryable: false,
    };
  }
  return { code: "provider_error", message: `${vendor} request failed (${failure.kind}): ${failure.reason}`, retryable: false };
};

export const createVendorTransport = (config: VendorTransportConfig): VendorTransport => {
  const base = config.baseUrl.replace(/\/$/, "");
  const host = new URL(base).host;

  /**
   * One request, with the credential resolved now rather than at construction.
   *
   * Per call so a rotated token takes effect without a restart — a credential read once at startup is one that
   * survives its own rotation, and the failure looks like the vendor rejecting a token that "has not changed".
   *
   * The header goes in through `headersFor`, which the runtime calls with the **validated** hostname only: a
   * credential issued for one host cannot be sent to another by asking for a URL that merely mentions it.
   */
  const request = async (
    context: ExecutionContext,
    path: string,
    init: {
      readonly method?: string;
      readonly body?: unknown;
      /** Sent verbatim instead of JSON-encoded, with `contentType`. For media endpoints — see `text`. */
      readonly rawBody?: string;
      readonly contentType?: string;
    } = {},
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
              ...(config.headers ?? {}),
              // Overrides the vendor's default, which is JSON for every other call this transport makes.
              ...(init.contentType === undefined ? {} : { "content-type": init.contentType }),
            }
          : undefined,
    });
    const outcome = await client.request({
      url: `${base}${path}`,
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(init.rawBody !== undefined
        ? { body: init.rawBody }
        : init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
      // Parsed here and never shown to the model verbatim, so the untrusted-content envelope would only corrupt
      // the JSON. Anything rendered as prose keeps the default fence.
      fence: false,
    });
    if (outcome.ok) return outcome.body;
    const failure = outcome;
    const described = config.classify?.(failure) ?? defaultClassification(failure, config.vendor);
    /**
     * `Retry-After`, carried through — and it was being dropped.
     *
     * `HttpFailure` parses the header and `PlatformError` has a field for it, and this transport joined them by
     * building an error that mentioned neither. Every toolkit on it therefore ignored a vendor that had said
     * *exactly* how long to wait, and fell back to a generic backoff — which is both slower than necessary and,
     * against a service that counts requests during the window, a way to stay throttled.
     *
     * A classifier may override it; otherwise the server's own number wins over any default, because the server
     * is the only party that knows.
     */
    const retryAfterMs = described.retryAfterMs ?? failure.retryAfterMs;
    /**
     * `AgentPlatformError`, not a decorated `Error`.
     *
     * `toPlatformError` maps anything else to `{ code: "internal", retryable: false }` — so a rate limit thrown
     * as `Object.assign(new Error(…), { retryable: true })` arrives at the model as permanently broken. The
     * extra properties simply vanish and nothing warns you.
     */
    throw new AgentPlatformError(retryAfterMs === undefined ? described : { ...described, retryAfterMs });
  };

  return {
    async json(context, path, init) {
      const body = await request(context, path, init);
      // **An empty body is a success.** A `204` from a delete, or a `201` from a fire-and-forget POST, has
      // nothing to parse — and `JSON.parse("")` throws, which reported two correct responses as parse failures.
      if (body.trim() === "") return undefined;
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new AgentPlatformError({
          code: "provider_error",
          message: `${config.vendor} returned a body that is not JSON`,
          retryable: false,
        });
      }
    },
    text(context, path, init) {
      // Not `json` with the parse failure caught: that discards the body, which is how a log-reading tool
      // shipped returning a placeholder on every success.
      return request(context, path, init ?? {});
    },
  };
};
