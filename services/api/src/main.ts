/**
 * Bootstrap — REQ-044 (#201).
 *
 * `enableShutdownHooks` is the line that matters. Without it Nest never calls `onApplicationShutdown`, so the
 * Postgres pool and the Redis connections survive SIGTERM — and a pool that outlives its process is a service
 * that fails its *next* deploy, when the new instance cannot get the connections the old one still holds. The
 * symptom arrives minutes later as a connection-limit error nobody associates with a restart.
 */

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { createSseMiddleware, SSE_PATH } from "./runs/sse.middleware.js";
import { RETINUE_AUTHENTICATE, RETINUE_RESOLVER_DEPS } from "./retinue/tokens.js";
import { loadServiceConfig } from "./retinue/config.js";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Authenticate } from "@retinue/agentkit/server";
import type { ResolverDeps } from "@retinue/agentkit";

export const bootstrap = async (): Promise<NestExpressApplication> => {
  const config = loadServiceConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(), { bufferLogs: false });

  /**
   * Mounted after the container is built, because the route needs the composed deps.
   *
   * Deliberately *not* a Nest controller: see `sse.middleware.ts` — the platform owns the frame format, and a
   * second implementation of it is a second set of the bugs #109 and #111 fixed.
   */
  const deps = app.get<ResolverDeps>(RETINUE_RESOLVER_DEPS);
  const authenticate = app.get<Authenticate>(RETINUE_AUTHENTICATE);
  app.use(SSE_PATH, createSseMiddleware({ deps, authenticate }));

  app.enableShutdownHooks();
  await app.listen(config.port);
  return app;
};

// `import.meta.main` is not available on this Node line, so the check is the module URL against argv[1] — the
// standard ESM equivalent, and it keeps this file importable by a test without starting a server.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const app = await bootstrap();
  const url = await app.getUrl();
  console.log(`
  Retinue — Nest.js API service
    graphql   ${url}/graphql
    sse       ${url}${SSE_PATH}
    probes    ${url}/healthz · ${url}/readyz

  Headers (dev auth reads them — this is not authentication):
    x-retinue-tenant: demo
    x-retinue-principal: you
    x-retinue-roles: operator
`);
}
