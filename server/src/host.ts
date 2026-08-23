/**
 * Reference GraphQL host (#108).
 *
 * `@agentkit/backend` ships the schema as SDL and a thin resolver map with **no server dependency**,
 * so a host can mount it on Yoga, Apollo or Mercurius. This is one such host, in its own workspace
 * precisely so the library keeps that property — AC-6 of #108 is that `@agentkit/backend` gained no
 * GraphQL-server dependency, and putting Yoga inside it would have failed that outright.
 *
 * It is a *reference* host, not the sanctioned one. Nothing here is business logic: the resolver map
 * is passed through untouched, and the only thing this layer decides is where the `ExecutionContext`
 * comes from.
 */
import { createGraphQLError, createSchema, createYoga } from "graphql-yoga";
import { createRunEventSseRoute, type SseRouteOptions } from "./sse-route.js";
import { createResolvers, typeDefs, type GraphQLContext, type ResolverDeps } from "@agentkit/backend";
import type { ExecutionContext } from "@agentkit/backend";

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

  if (options.sse?.enabled !== true) return yoga;

  const sse = createRunEventSseRoute({
    deps: options.deps,
    authenticate: options.authenticate,
    ...options.sse,
  });

  /**
   * One fetch handler for both surfaces. Composed rather than mounted on a router, because a router
   * would be a second framework decision this workspace has no need to make — and the whole point of
   * a fetch handler is that it composes.
   *
   * The returned object keeps Yoga's own shape (`fetch`, `graphqlEndpoint`) so callers and
   * `createServer(host)` are unaffected by whether SSE is enabled.
   */
  const fetch = async (
    input: Request | string | URL,
    init?: RequestInit,
    ...rest: readonly unknown[]
  ): Promise<Response> => {
    // Yoga's `fetch` accepts a Request, a URL or a string, and callers use all three. Normalising here
    // rather than assuming a Request: the first version of this read `request.url` off a string and
    // failed with "Invalid URL" for every caller that passed one.
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === sse.path) return sse.handle(request);
    return (yoga.fetch as (r: Request, ...a: readonly unknown[]) => Promise<Response>)(request, ...rest);
  };

  return Object.assign(fetch, yoga, { fetch, ssePath: sse.path });
};

export type AgentkitHost = ReturnType<typeof createAgentkitHost>;
