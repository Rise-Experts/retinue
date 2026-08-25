/**
 * The run-event stream — REQ-044 (#201).
 *
 * The platform's own SSE route, mounted as middleware rather than reimplemented as a Nest `@Sse()` handler.
 *
 * The temptation is real — Nest's `@Sse()` takes an RxJS `Observable` and does the framing for you — and taking
 * it would mean a second implementation of the frame format, the keep-alive comment, and the cursor resume. #111
 * is a whole issue about getting those frames right, and #109 shipped a route real clients could not reach.
 * Re-deriving that here would be re-deriving the bugs.
 *
 * So the platform's route stays authoritative and this file is a bridge: `createServerAdapter` turns a Fetch
 * handler into Node middleware, which is exactly the seam the route was written against.
 */

import { createServerAdapter } from "@whatwg-node/server";
import { createRunEventSseRoute } from "@retinue/agentkit/server";
import type { Authenticate } from "@retinue/agentkit/server";
import type { ResolverDeps } from "@retinue/agentkit";

export const SSE_PATH = "/runs/events";

export const createSseMiddleware = (options: { readonly deps: ResolverDeps; readonly authenticate: Authenticate }) => {
  const route = createRunEventSseRoute({
    deps: options.deps,
    authenticate: options.authenticate,
    path: SSE_PATH,
  });
  // The adapter takes the route's `handle` directly: everything about authentication, ownership, cursors and
  // framing stays inside the platform, and this service contributes only the plumbing.
  return createServerAdapter((request: Request) => route.handle(request));
};
