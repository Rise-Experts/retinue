# Subpath entry points

One file per published subpath (#196). Each exists so the heavy dependency behind it is an **optional peer** and
not something every consumer installs.

Importing the package root loads `ai` and `zod`. Nothing else.

| Entry | Subpath | Optional peer |
|---|---|---|
| `providers.ts` | `./providers` | the six `@ai-sdk/*` packages |
| `adapters-postgres.ts` | `./adapters/postgres` | `pg` |
| `adapters-redis.ts` | `./adapters/redis` | `ioredis` |
| `adapters-bullmq.ts` | `./adapters/bullmq` | `bullmq`, `ioredis` |
| `adapters-otel.ts` | `./adapters/otel` | *none* — the adapter takes structural types; the SDK appears only in its tests |

## Why there is no `./testing` yet

The SPEC left it open, and the build settles it for now: `src/testing/**` is **excluded** from `tsconfig.json`,
so the conformance suite is not compiled and cannot be an entry of this build. Shipping it means compiling it and
taking `vitest` as a peer dependency — which is a real decision about whether adapters written outside this
repository are a supported extension point, not a packaging detail to slip in.

Deferred deliberately rather than decided quietly. Until then an external adapter author cannot be held to the
same behaviour as the ones in here, and that is a gap worth naming.
