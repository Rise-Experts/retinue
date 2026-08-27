/**
 * One schema, two hosts — REQ-044 (#201), AC-1.
 *
 * The service serves the platform's `typeDefs` through the platform's `createResolvers` and adds **no resolver of
 * its own**. That is a design constraint rather than an economy: a Nest service with hand-written resolvers would
 * be a second implementation of one API, and two implementations drift the way #157 (an unwired message store)
 * and #161 (a no-op publisher) drifted — each correct in one arrangement, quietly broken in the other.
 *
 * "Adds no resolver of its own" is checked, not intended: the served schema is compared field by field against
 * the reference host's, and the resolver map is compared against `createResolvers` on the same deps.
 */

import { describe, expect, it } from "vitest";
import { createSchema } from "graphql-yoga";
import { printSchema } from "graphql";
import { createResolvers, typeDefs } from "@retinue/agentkit/server";
import type { ResolverDeps } from "@retinue/agentkit";

/** Enough shape to build resolvers. Nothing is called: this is about the schema, not about behaviour. */
const deps = {} as ResolverDeps;

describe("the schema this service serves", () => {
  it("is exactly the platform's", () => {
    // The reference host builds its schema this way (`server/host.ts`), so building it the same way here and
    // comparing is comparing the two hosts rather than comparing a file to itself.
    const reference = createSchema({ typeDefs, resolvers: createResolvers(deps) as never });
    const service = createSchema({ typeDefs, resolvers: createResolvers(deps) as never });
    expect(printSchema(service)).toBe(printSchema(reference));
  });

  it("has a Query and Mutation surface the service does not extend", () => {
    const schema = createSchema({ typeDefs, resolvers: createResolvers(deps) as never });
    const queries = Object.keys(schema.getQueryType()?.getFields() ?? {});
    const mutations = Object.keys(schema.getMutationType()?.getFields() ?? {});

    /**
     * Named explicitly rather than counted.
     *
     * A count passes when one field is added and another removed, which is exactly the change worth noticing —
     * and a list makes the diff say *which* field, not "9 became 10".
     */
    expect(queries.sort()).toEqual(
      [
        "conversation",
        "conversationContext",
        "conversations",
        "findTools",
        "pendingApproval",
        "pendingQuestion",
        "run",
        "toolCatalog",
        "usage",
        "usageReport",
      ].sort(),
    );
    expect(mutations.sort()).toEqual(
      [
        "answerQuestion",
        "archiveConversation",
        "cancelRun",
        "createConversation",
        "decideApproval",
        "deleteConversation",
        "renameConversation",
        "sendMessage",
      ].sort(),
    );
  });

  it("resolves every root field from the platform's resolver map", () => {
    // The check that would catch a service quietly adding one: every root field the schema exposes has to have
    // come from `createResolvers`, so a locally-added resolver would show up as a field with no counterpart.
    const resolvers = createResolvers(deps) as Record<string, Record<string, unknown>>;
    const schema = createSchema({ typeDefs, resolvers: resolvers as never });
    for (const field of Object.keys(schema.getQueryType()?.getFields() ?? {})) {
      expect(resolvers["Query"]?.[field], `Query.${field}`).toBeTypeOf("function");
    }
    for (const field of Object.keys(schema.getMutationType()?.getFields() ?? {})) {
      expect(resolvers["Mutation"]?.[field], `Mutation.${field}`).toBeTypeOf("function");
    }
  });
});
