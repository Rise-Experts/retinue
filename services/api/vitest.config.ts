import { defineConfig } from "vitest/config";
import { reporters } from "../../vitest.shared.js";

export default defineConfig({
  /**
   * One `graphql` instance.
   *
   * `graphql` ships CJS and ESM, and under vitest one import path can resolve the CJS build while another
   * resolves the ESM one — two module instances, so a `GraphQLScalarType` built by the first is rejected by the
   * second with "Cannot use GraphQLScalarType from another module or realm". There is exactly one copy on disk;
   * this is a loader artifact, and the service itself boots and serves correctly without it.
   *
   * Deduped rather than worked around in the test, because the test that would work around it is a weaker test.
   */
  resolve: { dedupe: ["graphql"] },
  test: {
    // JUnit XML when CI asks for it, so Jenkins can show test trends. See `vitest.shared.ts`.
    ...reporters("api-service"),
    // Inlined so vitest transforms them through one module graph. `dedupe` alone was not enough: the packages
    // that build scalars are pre-bundled dependencies, and a pre-bundled CJS copy is the second realm.
    server: { deps: { inline: ["graphql", "graphql-yoga", "@graphql-tools/schema", "@retinue/agentkit"] } },
    // Source only, never the compiled copy: running `dist` would test yesterday's build and pass.
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 30_000,
  },
});
