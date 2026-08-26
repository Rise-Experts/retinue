/**
 * GraphQL — REQ-044 (#201).
 *
 * The platform's `typeDefs` and the platform's `createResolvers`, and **no resolver of this service's own**. That
 * is the design constraint, not an economy: a Nest service with hand-written resolvers would be a second
 * implementation of one API, and two implementations of one thing drift the way #157 and #161 drifted — each
 * correct in one arrangement and quietly broken in the other. A test compares the served schema against the
 * reference host's, so "no resolver of its own" is checked rather than intended.
 *
 * Yoga rather than Apollo as the driver, because the reference host is Yoga. One GraphQL engine across the repo
 * means one set of error-masking rules and one context contract; two would mean an authentication refusal that
 * renders as 401 in one host and as a masked 500 in the other, which is exactly the bug the reference host's own
 * comments record hitting.
 */

import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";
import { YogaDriver } from "@graphql-yoga/nestjs";
import type { YogaDriverConfig } from "@graphql-yoga/nestjs";
import { createGraphQLError } from "graphql-yoga";
import { createResolvers, typeDefs } from "@retinue/agentkit/server";
import { UNAUTHENTICATED } from "@retinue/agentkit/server";
import { RETINUE_AUTHENTICATE, RETINUE_RESOLVER_DEPS } from "../retinue/tokens.js";
import type { Authenticate } from "@retinue/agentkit/server";
import type { ResolverDeps } from "@retinue/agentkit";

@Module({
  imports: [
    GraphQLModule.forRootAsync<YogaDriverConfig>({
      driver: YogaDriver,
      inject: [RETINUE_RESOLVER_DEPS, RETINUE_AUTHENTICATE],
      useFactory: (deps: ResolverDeps, authenticate: Authenticate) => ({
        typeDefs,
        resolvers: createResolvers(deps) as never,
        graphqlEndpoint: "/graphql",
        landingPage: false,
        /**
         * The only place an `ExecutionContext` is constructed.
         *
         * Yoga runs this **before execution**, so a throw here means no resolver runs — a stronger statement than
         * "the response was a 401". And because it is the only construction site, there is no ambient tenant for
         * a request to fall back to: a resolver cannot see a context nobody built.
         *
         * `createGraphQLError` rather than a bare `GraphQLError`: Yoga masks errors it considers unexpected, and
         * a context-factory throw is one of them, so a plain error comes back as a 500 "Unexpected error" — an
         * authentication refusal rendered as a server fault.
         */
        context: async ({ request }: { request: Request }) => {
          const execution = await authenticate(request);
          if (execution === null || execution === undefined) {
            throw createGraphQLError("Unauthenticated", {
              extensions: { code: UNAUTHENTICATED, http: { status: 401 } },
            });
          }
          return { execution };
        },
      }),
    }),
  ],
})
export class RetinueGraphQLModule {}
