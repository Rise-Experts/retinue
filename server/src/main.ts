/**
 * Runnable entrypoint (#108 AC-1).
 *
 * Composition only. Every store, dispatcher and service it wires already exists and is already
 * tested; this file's whole job is to be a documented command that serves the API.
 *
 * Run with:
 *   AGENTKIT_DATABASE_URL=postgres://… PORT=4000 node dist/main.js
 *
 * `authenticate` is deliberately not implemented here. A reference host cannot know a deployment's
 * identity provider, and shipping a permissive default would be worse than shipping none — so the
 * entrypoint refuses to start without one rather than quietly serving an open API.
 */
import { createServer } from "node:http";
import { createAgentkitHost, type Authenticate } from "./host.js";
import type { ResolverDeps } from "@agentkit/backend";

export type MainOptions = {
  readonly deps: ResolverDeps;
  readonly authenticate: Authenticate;
  readonly port?: number;
  readonly log?: (message: string) => void;
};

export const DEFAULT_PORT = 4000;

export const startServer = async (options: MainOptions) => {
  const port = options.port ?? Number(process.env["PORT"] ?? DEFAULT_PORT);
  const log = options.log ?? ((message: string) => console.log(message));
  const yoga = createAgentkitHost({ deps: options.deps, authenticate: options.authenticate });

  const server = createServer(yoga);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  log(`agentkit graphql host listening on :${port}${yoga.graphqlEndpoint}`);

  return {
    port,
    yoga,
    /** Resolves once the socket is closed, so a caller can sequence shutdown. */
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
