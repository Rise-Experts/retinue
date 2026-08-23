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
};

/** Thrown when a request carries no usable identity. Surfaces as a GraphQL error, not a crash. */
export const UNAUTHENTICATED = "UNAUTHENTICATED";

export const createAgentkitHost = (options: HostOptions) => {
  // Passed through untouched. AC-5 is "no business logic was added to the resolver layer", and the
  // strongest form of that is a host that adds no resolver of its own — asserted in the tests.
  const resolvers = createResolvers(options.deps);

  return createYoga<Record<string, never>, GraphQLContext>({
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
};

export type AgentkitHost = ReturnType<typeof createAgentkitHost>;
