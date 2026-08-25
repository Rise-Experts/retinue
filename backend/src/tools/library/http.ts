/**
 * Arbitrary HTTP — REQ-039 (#188).
 *
 * ## Why this is two tools and not one with a `method` argument
 *
 * The AC is that "every external or destructive one routes through approval and idempotency **by construction**
 * rather than by the author remembering." Effect is a property of the *tool*: the registry reads
 * `descriptor.effect` to decide whether an approval and an idempotency key are required, and it reads it before it
 * has seen the arguments. So a single `http_request` tool taking `method` could only be classified one way —
 * either `read`, and a model can POST without an approval by passing `method: "POST"`, or `external-write`, and
 * every page read needs a human. Both are wrong, and the first is a hole with a plausible-looking description.
 *
 * Splitting them makes the classification structural: `http_request` cannot send a mutating method because its
 * schema has no field for one, and `http_write` is `external-write`, so it cannot execute without an approval and
 * an idempotency key no matter what it is asked to do.
 *
 * ## Credentials
 *
 * Neither tool takes an `Authorization` header, and the client refuses one supplied through `headers` anyway.
 * Credentials are configured per host by the deployment (`headersFor` in `toolkit/http.ts`), so a model cannot
 * name the credential it wants spent, cannot send one to a host it was not issued for, and cannot read one back.
 */

import { z } from "zod";
import { defineDelegatingTool } from "../delegating.js";
import type { DelegatingToolDeps } from "../delegating.js";
import type { Tool } from "../index.js";
import type { HttpClient, HttpOutcome } from "../../toolkit/index.js";

/** Headers a caller may pass. Not an allow-list of names — a bound on how many and how long. */
const headersSchema = z.record(z.string().min(1).max(128), z.string().max(1_024)).optional();

const readSchema = z
  .object({
    url: z.string().min(1).max(2_048),
    method: z.enum(["GET", "HEAD"]).default("GET"),
    headers: headersSchema,
  })
  .strict();

const writeSchema = z
  .object({
    url: z.string().min(1).max(2_048),
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    headers: headersSchema,
    body: z.string().max(100_000).optional(),
  })
  .strict();

export const createHttpRequestTool = (deps: DelegatingToolDeps, client: HttpClient): Tool =>
  defineDelegatingTool(deps, {
    name: "http_request",
    label: "Make an HTTP request",
    description:
      "Send a GET or HEAD request to an https URL and return the response. Read-only: use http_write to send " +
      "anything that changes state. Authorization and cookie headers cannot be set — credentials are configured " +
      "per host by the operator.",
    category: "web",
    effect: "read",
    inputSchema: readSchema,
    delegatesTo: "toolkit/http.HttpClient.request",
    delegate: (input: z.infer<typeof readSchema>): Promise<HttpOutcome> =>
      client.request({ url: input.url, method: input.method, headers: input.headers }),
  });

export const createHttpWriteTool = (deps: DelegatingToolDeps, client: HttpClient): Tool =>
  defineDelegatingTool(deps, {
    name: "http_write",
    label: "Send a request that changes something",
    description:
      "Send a POST, PUT, PATCH or DELETE request to an https URL. This changes state on another system, so it " +
      "requires approval and runs at most once per request. Authorization and cookie headers cannot be set.",
    category: "web",
    /**
     * `external-write`, so `defineTool`'s defaults give it `approvalPolicy: "always"` and require an idempotency
     * key, and the registry refuses it outright if either the approval check or the idempotency store is unwired.
     * That refusal is the guarantee: a deployment cannot end up with an unapproved outbound write by forgetting
     * something.
     */
    effect: "external-write",
    inputSchema: writeSchema,
    delegatesTo: "toolkit/http.HttpClient.request",
    delegate: (input: z.infer<typeof writeSchema>): Promise<HttpOutcome> =>
      client.request({ url: input.url, method: input.method, headers: input.headers, body: input.body }),
  });
