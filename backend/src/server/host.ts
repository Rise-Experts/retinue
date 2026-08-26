/**
 * Reference GraphQL host (#108).
 *
 * `@retinue/agentkit` ships the schema as SDL and a thin resolver map with **no server dependency**,
 * so a host can mount it on Yoga, Apollo or Mercurius. This is one such host, in its own workspace
 * precisely so the library keeps that property — AC-6 of #108 is that `@retinue/agentkit` gained no
 * GraphQL-server dependency, and putting Yoga inside it would have failed that outright.
 *
 * It is a *reference* host, not the sanctioned one. Nothing here is business logic: the resolver map
 * is passed through untouched, and the only thing this layer decides is where the `ExecutionContext`
 * comes from.
 */
import { createGraphQLError, createSchema, createYoga } from "graphql-yoga";
import { createServerAdapter } from "@whatwg-node/server";
import { createRunEventSseRoute, type SseRouteOptions } from "./sse-route.js";
import type { HealthRoutes } from "./health.js";
import { createResolvers, typeDefs } from "../graphql/index.js";
import type { GraphQLContext, ResolverDeps } from "../index.js";
import type { ExecutionContext } from "../index.js";

/**
 * Turns a request into an execution context, or `null` to refuse it.
 *
 * Deliberately the caller's function. Identity is the one thing a library cannot supply — it depends
 * on the deployment's identity provider — and a default would be worse than an absent one. Note the
 * consequence, recorded as an open question on #108: the security-critical step is entirely the
 * caller's, and nothing here can verify it does the right thing.
 */
export type Authenticate = (request: Request) => Promise<ExecutionContext | null> | ExecutionContext | null;

export type HostOptions = {
  readonly deps: ResolverDeps;
  readonly authenticate: Authenticate;
  /** GraphQL endpoint path. Defaults to `/graphql`. */
  readonly graphqlEndpoint?: string;
  /** Landing page and introspection are off by default; a reference host is not a playground. */
  readonly graphiql?: boolean;
  /**
   * Also serve the SSE streaming endpoint (#109) on the same fetch handler. Optional because the
   * embedded profile is one deployment shape, not the only one — a host using GraphQL subscriptions
   * exclusively should not have a second streaming surface it never wanted.
   */
  readonly sse?: Omit<SseRouteOptions, "deps" | "authenticate"> & { readonly enabled: boolean };
  /**
   * Health and readiness routes, served **before** authentication. Deliberately: a load balancer has
   * no credentials, and a probe that required them would report every healthy pod as unhealthy.
   */
  readonly health?: HealthRoutes;
};

/** Thrown when a request carries no usable identity. Surfaces as a GraphQL error, not a crash. */
export const UNAUTHENTICATED = "UNAUTHENTICATED";

export const createAgentkitHost = (options: HostOptions) => {
  // Passed through untouched. AC-5 is "no business logic was added to the resolver layer", and the
  // strongest form of that is a host that adds no resolver of its own — asserted in the tests.
  const resolvers = createResolvers(options.deps);

  const yoga = createYoga<Record<string, never>, GraphQLContext>({
    schema: createSchema({ typeDefs, resolvers: resolvers as never }),
    graphqlEndpoint: options.graphqlEndpoint ?? "/graphql",
    graphiql: options.graphiql ?? false,
    landingPage: false,
    /**
     * The single place an `ExecutionContext` is constructed, which is what makes AC-2 and AC-3 one
     * mechanism rather than two.
     *
     * Yoga runs this **before execution**, so throwing here means no resolver runs — that is AC-2,
     * and it is a stronger statement than "the response was a 401". And because this is the only
     * construction site, there is no ambient or default tenant for a request to fall back to, which
     * is AC-3. A resolver cannot see a context it did not construct because there is nowhere else for
     * one to come from.
     */
    context: async ({ request }): Promise<GraphQLContext> => {
      const execution = await options.authenticate(request);
      if (execution === null || execution === undefined) {
        // `createGraphQLError` rather than a bare `new GraphQLError`. Yoga masks errors it considers
        // unexpected, and a context-factory throw is one of them — a plain GraphQLError comes back as
        // a 500 "Unexpected error", which would turn an authentication refusal into what looks like a
        // server fault. Verified: the first version of this did exactly that.
        throw createGraphQLError("Unauthenticated", {
          extensions: { code: UNAUTHENTICATED, http: { status: 401 } },
        });
      }
      return { execution };
    },
  });

  const health = options.health;

  if (options.sse?.enabled !== true && health === undefined) return yoga;

  const sse =
    options.sse?.enabled === true
      ? createRunEventSseRoute({ deps: options.deps, authenticate: options.authenticate, ...options.sse })
      : null;

  /**
   * One fetch handler for both surfaces. Composed rather than mounted on a router, because a router
   * would be a second framework decision this workspace has no need to make — and the whole point of
   * a fetch handler is that it composes.
   */
  /**
   * Whether this is already a request.
   *
   * Duck-typed on `url` and `headers`, because there can be more than one `Request` class in a process and a
   * nominal check picks the wrong one silently.
   */
  const isRequestLike = (value: unknown): value is Request =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { url?: unknown }).url === "string" &&
    typeof (value as { headers?: unknown }).headers === "object";

  const handle = async (
    input: Request | string | URL,
    init?: RequestInit,
    ...rest: readonly unknown[]
  ): Promise<Response> => {
    /**
     * Normalised **structurally**, not with `instanceof Request`.
     *
     * Yoga's `fetch` accepts a Request, a URL or a string, and callers use all three — the first version of this
     * read `request.url` off a string and failed with "Invalid URL" for every caller that passed one.
     *
     * But `instanceof` was wrong too, and more subtly (#155). `@whatwg-node/server` — which Yoga itself is built
     * on — constructs requests from its own ponyfilled class, so a genuine request arriving through the Node
     * adapter is **not** `instanceof` the global `Request`. The check failed, the object fell through to
     * `new Request(String(input))`, and every request died on `Failed to parse URL from [object Request]`.
     *
     * A request is a thing with a URL. Testing for that works across every implementation, which is the property
     * that matters when two of them are in the same process.
     */
    const request = isRequestLike(input) ? input : new Request(String(input), init);
    const url = new URL(request.url);
    // Probes first and unauthenticated: a load balancer carries no credentials.
    const probe = await health?.handle(request);
    if (probe !== null && probe !== undefined) return probe;
    if (sse !== null && url.pathname === sse.path) return sse.handle(request);
    return (yoga.fetch as (r: Request, ...a: readonly unknown[]) => Promise<Response>)(request, ...rest);
  };

  /**
   * A **server adapter**, so the returned object is both a fetch handler *and* a Node request listener.
   *
   * This was a real bug, found the first time anything actually served a request (#155). The previous version
   * returned `Object.assign(fetch, yoga, …)` — a function whose callable body was the WHATWG `fetch`. Node's
   * `http.createServer(listener)` calls its listener with `(IncomingMessage, ServerResponse)`, so
   * `createServer(host)` reached `new Request(String(incomingMessage))` and threw
   * `Failed to parse URL from [object Object]` on **every** request.
   *
   * The doc comment above it claimed "callers and `createServer(host)` are unaffected", and that claim had never
   * been executed: the tests call `host.fetch(new Request(…))` directly, which is the one path that worked.
   * `main.ts` — the documented way to run this — could not serve anything.
   *
   * `createServerAdapter` is what Yoga itself is built on, so this is the same conversion Yoga would have done,
   * applied to the composed handler instead of to Yoga alone. Health probes and SSE now reach the Node path too;
   * before, they were only reachable by a caller who already had a `Request`.
   */
  const adapter = createServerAdapter(handle as (request: Request) => Promise<Response>);

  // Yoga's own shape is preserved on top (`graphqlEndpoint`, `getEnveloped`, …) for callers that read it, and
  // `fetch` is pinned to the adapter so one object serves both styles.
  return Object.assign(adapter, yoga, {
    fetch: adapter as unknown as typeof yoga.fetch,
    handle,
    ...(sse === null ? {} : { ssePath: sse.path }),
  });
};

export type AgentkitHost = ReturnType<typeof createAgentkitHost>;
