/**
 * `tools-azure` — REQ-054 (#232), task #236.
 *
 * The package where the tests matter most, because the two writes are the only ones in this sprint that can
 * take a production service down. Four of these guard things that are invisible when they break:
 *
 * - **AC-2** every tool that is not one of the two named writes is `read`. A create tool added later without
 *   touching `AZURE_GATED` fails here, which is the only mechanism that keeps a package read-first after the
 *   person who decided it has moved on.
 * - **AC-3** an unbounded log query is refused rather than shortened. A silently-narrowed query answers a
 *   different question and reports success.
 * - **AC-5** a malformed resource id fails *locally* — asserted by the request never being made, not by the
 *   message, because "it errored" and "it errored before sending" are different guarantees.
 * - **AC-6** Azure's two meanings for 403 get different platform codes.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@retinue/agentkit";
import {
  bearer,
  refreshable,
  withRefreshingCredentials,
  type CredentialRefresher,
  type CredentialResolver,
  type RefreshableCredential,
} from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";
import { readFileSync, readdirSync } from "node:fs";

import {
  AZURE_GATED,
  AZURE_TOOL_NAMES,
  azureErrorCode,
  boundQuery,
  createAzureToolkit,
  deniedAction,
  isValidResourceId,
  MAX_TIMESPAN_HOURS,
  parseResourceId,
  RESTART_ROLES,
  TOOL_ROLES,
  typeOf,
} from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
};

const SUB = "00000000-1111-2222-3333-444444444444";
const VM = `/subscriptions/${SUB}/resourceGroups/prod/providers/Microsoft.Compute/virtualMachines/web-01`;
const WORKSPACE = `/subscriptions/${SUB}/resourceGroups/prod/providers/Microsoft.OperationalInsights/workspaces/logs`;

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const resolver: CredentialResolver = { async resolve() { return bearer("arm.token"); } };

const run = async (name: string, fetchImpl: typeof fetch, input: unknown, credentials = resolver) => {
  const tools = await createAzureToolkit({ credentialRef: "azure", resolver: credentials, fetchImpl }).listTools(
    context,
  );
  const tool = tools.find((candidate) => candidate.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

type Call = [string, { method?: string; body?: string; headers?: Record<string, string> | Headers }];
const calls = (fetchImpl: typeof fetch): Call[] =>
  (fetchImpl as unknown as { mock: { calls: Call[] } }).mock.calls;

/** Headers arrive as a record or a `Headers`; read either, lowercased. */
const headerOf = (call: Call, name: string): string | undefined => {
  const headers = call[1]?.headers;
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
};

/** Narrows a tool outcome to its failure shape, which is what most of these assertions are about. */
const failed = (outcome: unknown) =>
  outcome as { ok: false; error: { code: string; message: string; retryable: boolean; retryAfterMs?: number } };

describe("the surface is read-first — AC-2", () => {
  it("every tool that is not one of the two named writes is a read", async () => {
    const tools = await createAzureToolkit({
      credentialRef: "azure",
      resolver,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    }).listTools(context);

    expect(tools.map((tool) => tool.descriptor.name).sort()).toEqual([...AZURE_TOOL_NAMES].sort());

    for (const tool of tools) {
      const expected = AZURE_GATED[tool.descriptor.name] ?? "read";
      expect(tool.descriptor.effect, tool.descriptor.name).toBe(expected);
    }
    // Stated the other way round too: the gated list names tools that exist, so a rename cannot leave a stale
    // entry silently excusing a tool from the `read` assertion above.
    for (const name of Object.keys(AZURE_GATED)) {
      expect(AZURE_TOOL_NAMES as readonly string[]).toContain(name);
    }
  });

  it("restart is destructive, tag is the only confirms, and both are gated", async () => {
    const tools = await createAzureToolkit({
      credentialRef: "azure",
      resolver,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    }).listTools(context);
    const by = (name: string) => tools.find((tool) => tool.descriptor.name === name)!.descriptor;

    expect(by("azure_restart_resource").effect).toBe("destructive");
    expect(by("azure_tag_resource").effect).toBe("external-write");
    expect(tools.filter((tool) => tool.descriptor.effect === "external-write")).toHaveLength(1);
    expect(tools.filter((tool) => tool.descriptor.effect === "destructive")).toHaveLength(1);

    for (const name of Object.keys(AZURE_GATED)) {
      expect(by(name).approvalPolicy, name).toBe("always");
      expect(by(name).requiresIdempotencyKey, name).toBe(true);
    }
    for (const tool of tools.filter((candidate) => candidate.descriptor.effect === "read")) {
      expect(tool.descriptor.approvalPolicy, tool.descriptor.name).toBe("never");
    }
  });

  it("there is no create, delete, scale or deploy tool", () => {
    // The Limits section of the integration page is a promise; this is the part of it that is checked.
    for (const name of AZURE_TOOL_NAMES) {
      expect(name).not.toMatch(/create|delete|scale|deploy|assign|provision|remove/);
    }
  });
});

describe("resource ids are validated locally — AC-5", () => {
  const bad: [string, string][] = [
    ["", "empty"],
    ["web-01", "a bare name"],
    [`/subscriptions/${SUB}/resourceGroups/prod`, "a group, not a resource"],
    [`/subscriptions/not-a-guid/resourceGroups/prod/providers/Microsoft.Compute/virtualMachines/web-01`, "a subscription that is not a GUID"],
    [`/subscriptions/${SUB}/resourceGroups/prod/providers/Microsoft.Compute/virtualMachines`, "a type with no name"],
    [`/subscriptions/${SUB}/resourceGroups/prod/providers/Compute/virtualMachines/web-01`, "a namespace with no dot"],
    [`/subscriptions/${SUB}//resourceGroups/prod/providers/Microsoft.Compute/virtualMachines/web-01`, "a doubled slash"],
    [`/subscriptions/${SUB}/resourceGroups/prod/providers/Microsoft.Compute/virtualMachines/web?api-version=evil`, "a query string smuggled into a name"],
    [`/subscriptions/${SUB}/resourceGroups/prod/providers/Microsoft.Compute/virtualMachines/web%2f..%2fother`, "a percent-encoded slash"],
    [`/subscriptions/${SUB}/resourceGroups/prod/providers/Microsoft.Compute/virtualMachines/web 01`, "a space"],
    [`/subscriptions/${SUB}/resourceGroups/prod/providers/Microsoft.Compute/virtualMachines/web#frag`, "a fragment"],
  ];

  it.each(bad)("refuses %s (%s)", (id) => {
    expect(isValidResourceId(id)).toBe(false);
    expect(() => parseResourceId(id)).toThrow();
  });

  it("accepts a well-formed id, a child resource, and a subscription-scoped one", () => {
    expect(parseResourceId(VM)).toMatchObject({
      subscriptionId: SUB,
      resourceGroup: "prod",
      namespace: "Microsoft.Compute",
      type: "Microsoft.Compute/virtualMachines",
      name: "web-01",
    });
    const child = `${VM}/extensions/monitoring`;
    expect(parseResourceId(child)).toMatchObject({ type: "Microsoft.Compute/virtualMachines/extensions", name: "monitoring" });
    // No resource group: legal, and the parser must not require one.
    expect(parseResourceId(`/subscriptions/${SUB}/providers/Microsoft.Authorization/policyAssignments/p1`).resourceGroup).toBeUndefined();
    // ARM writes `resourceGroups` and accepts `resourcegroups`; a pasted id may be either.
    expect(isValidResourceId(VM.replace("resourceGroups", "resourcegroups"))).toBe(true);
  });

  it("a malformed id is refused before anything is sent", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = failed(await run("azure_get_resource", fetchImpl, { resourceId: "not-an-id" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.error.code).toBe("invalid_input");
    // The guarantee is *locally*, so the evidence is the absence of a request — not the wording of the error.
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it("a name carrying a query string cannot reach an authenticated ARM request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const injected = `/subscriptions/${SUB}/resourceGroups/prod/providers/Microsoft.Compute/virtualMachines/x?api-version=2015-01-01&forced=1`;
    const outcome = failed(await run("azure_restart_resource", fetchImpl, { resourceId: injected }));
    expect(outcome.error.code).toBe("invalid_input");
    expect(calls(fetchImpl)).toHaveLength(0);
  });
});

describe("log queries are bounded, and refuse rather than clamp — AC-3", () => {
  it("rejects a query with no time span, without running it", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = failed(
      await run("azure_query_logs", fetchImpl, { workspaceId: WORKSPACE, query: "AzureDiagnostics" }),
    );
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.message).toMatch(/time span/i);
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it("refuses a span past the maximum instead of shortening it", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = failed(
      await run("azure_query_logs", fetchImpl, {
        workspaceId: WORKSPACE,
        query: "AzureDiagnostics",
        timespanHours: MAX_TIMESPAN_HOURS + 1,
      }),
    );
    expect(outcome.error.code).toBe("invalid_input");
    // The number is in the message: a limit a caller cannot see is one they cannot work within.
    expect(outcome.error.message).toContain(String(MAX_TIMESPAN_HOURS));
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it("bounds rows, reports truncation, and sends the timespan", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => [`2026-08-29T0${index}:00:00Z`, "Error"]);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ tables: [{ name: "PrimaryResult", columns: [{ name: "TimeGenerated" }, { name: "Level" }], rows }] }),
    ) as unknown as typeof fetch;

    const outcome = (await run("azure_query_logs", fetchImpl, {
      workspaceId: WORKSPACE,
      query: "AzureDiagnostics | where Level == 'Error'",
      timespanHours: 6,
      limit: 3,
    })) as { ok: true; data: { rows: unknown[]; truncated: boolean; rowCount: number } };

    expect(outcome.ok).toBe(true);
    expect(outcome.data.rows).toHaveLength(3);
    expect(outcome.data.rowCount).toBe(3);
    // Four came back for a limit of three, which is exactly how the extra row proves truncation.
    expect(outcome.data.truncated).toBe(true);
    // Columnar rows become objects, so a model does not have to count positions.
    expect(outcome.data.rows[0]).toEqual({ TimeGenerated: "2026-08-29T00:00:00Z", Level: "Error" });

    const body = JSON.parse(calls(fetchImpl)[0]![1].body as string) as { query: string; timespan: string };
    expect(body.timespan).toBe("PT6H");
    expect(body.query).toContain("| take 4");
  });

  it("appends the row bound safely to queries that would otherwise break", () => {
    // A trailing semicolon is legal KQL (let statements are separated by them) and `…;\n| take` is not.
    expect(boundQuery("let x = 1;", 10)).toBe("let x = 1\n| take 11");
    // A trailing line comment would swallow anything appended to the same line.
    expect(boundQuery("Heartbeat // recent", 10)).toBe("Heartbeat // recent\n| take 11");
    expect(() => boundQuery("   ", 10)).toThrow();
  });
});

describe("throttling uses Azure's number — AC-4", () => {
  it("a 429 carries Retry-After through to the platform error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "TooManyRequests", message: "slow down" } }, 429, {
        "retry-after": "47",
        "x-ms-ratelimit-remaining-subscription-reads": "0",
      }),
    ) as unknown as typeof fetch;

    const outcome = failed(await run("azure_list_subscriptions", fetchImpl, {}));
    expect(outcome.error.code).toBe("rate_limited");
    expect(outcome.error.retryable).toBe(true);
    /**
     * The number, not a default backoff.
     *
     * This is the assertion the whole AC comes down to, and it failed when written: the shared transport
     * parsed `Retry-After` into `HttpFailure.retryAfterMs` and then built a `PlatformError` without it, so
     * every toolkit in this repository was ignoring vendors that had said exactly how long to wait.
     */
    expect(outcome.error.retryAfterMs).toBe(47_000);
    // The read budget is surfaced too, so an operator can see a throttle approaching rather than discover it.
    expect(outcome.error.message).toContain("Reads left on this subscription: 0");
  });

  it("a 503 with Retry-After is retryable and keeps the number", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "ServiceUnavailable", message: "try later" } }, 503, { "retry-after": "5" }),
    ) as unknown as typeof fetch;
    const outcome = failed(await run("azure_list_subscriptions", fetchImpl, {}));
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.retryAfterMs).toBe(5_000);
  });
});

describe("a 403 says which kind it is — AC-6", () => {
  it("a missing role is `forbidden`, and names the role and the action", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "AuthorizationFailed",
            message:
              "The client 'agent@example.com' with object id '…' does not have authorization to perform action " +
              "'Microsoft.Compute/virtualMachines/restart/action' over scope '/subscriptions/…'.",
          },
        },
        403,
      ),
    ) as unknown as typeof fetch;

    const outcome = failed(await run("azure_restart_resource", fetchImpl, { resourceId: VM }));
    expect(outcome.error.code).toBe("forbidden");
    expect(outcome.error.message).toContain("Microsoft.Compute/virtualMachines/restart/action");
    // The role for *this* resource type, which is the thing an administrator has to grant.
    expect(outcome.error.message).toContain("Virtual Machine Contributor");
    // And it says plainly that the remedy an operator would otherwise reach for is the wrong one.
    expect(outcome.error.message).toMatch(/Reconnecting the account will not fix it/);
    expect(outcome.error.retryable).toBe(false);
  });

  it("an expired token is `unauthorized`, even when Azure answers 403", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "ExpiredAuthenticationToken", message: "token expired" } }, 403),
    ) as unknown as typeof fetch;
    const outcome = failed(await run("azure_get_resource", fetchImpl, { resourceId: VM }));
    // The whole point: same status, opposite remedy, different code.
    expect(outcome.error.code).toBe("unauthorized");
    expect(outcome.error.message).toMatch(/Granting an RBAC role will not fix it/);
  });

  it("a 401 with no recognisable code is a credential problem, not a role problem", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const outcome = failed(await run("azure_get_resource", fetchImpl, { resourceId: VM }));
    expect(outcome.error.code).toBe("unauthorized");
  });

  it("a 403 with no recognisable code is a role problem", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const outcome = failed(await run("azure_list_subscriptions", fetchImpl, {}));
    expect(outcome.error.code).toBe("forbidden");
    expect(outcome.error.message).toContain("Reader");
  });

  it("reads Azure's code and denied action out of a body", () => {
    expect(azureErrorCode('{"error":{"code":"AuthorizationFailed","message":"…"}}')).toBe("AuthorizationFailed");
    expect(azureErrorCode("not json at all")).toBeUndefined();
    expect(deniedAction("does not have authorization to perform action 'Microsoft.Web/sites/restart/action' over")).toBe(
      "Microsoft.Web/sites/restart/action",
    );
  });
});

describe("the credential refreshes across an expiry — AC-1", () => {
  it("an expiring token is renewed before the call, and the new one is sent", async () => {
    let clock = Date.parse("2026-08-29T12:00:00Z");
    const expired = refreshable(bearer("stale.token"), new Date(clock + 10_000).toISOString());
    const fresh: RefreshableCredential = refreshable(bearer("fresh.token"), new Date(clock + 3_600_000).toISOString());

    const refresh = vi.fn(async () => fresh);
    const refresher: CredentialRefresher = { refresh };
    const refreshing = withRefreshingCredentials(
      { async resolve() { return expired; } },
      refresher,
      { now: () => clock },
    );

    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] })) as unknown as typeof fetch;
    await run("azure_list_subscriptions", fetchImpl, {}, refreshing);

    // The token on the wire is the refreshed one — the assertion that a *stale* credential never reaches Azure.
    expect(headerOf(calls(fetchImpl)[0]!, "authorization")).toBe("Bearer fresh.token");
    expect(refresh).toHaveBeenCalledTimes(1);

    // A second call inside the new token's life must not refresh again: refresh endpoints rate limit, and
    // several vendors invalidate the previous refresh token when one is used.
    clock += 60_000;
    await run("azure_list_subscriptions", fetchImpl, {}, refreshing);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(headerOf(calls(fetchImpl)[1]!, "authorization")).toBe("Bearer fresh.token");
  });

  it("refreshing keeps the secret non-enumerable, so it cannot be logged", () => {
    const credential = refreshable(bearer("secret.token"), "2027-01-01T00:00:00Z");
    expect(JSON.stringify(credential)).not.toContain("secret.token");
    expect(credential.expiresAt).toBe("2027-01-01T00:00:00Z");
  });
});

describe("nothing here reads the environment or an ambient login — AC-7", () => {
  it("the package source mentions no ambient credential source", () => {
    const dir = new URL("../", import.meta.url).pathname;
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(4);
    /**
     * A source scan, and a blunt one on purpose.
     *
     * A toolkit that silently works because the developer is logged in with `az login`, or because it is
     * running on a VM with a managed identity, is the "passes having checked nothing" pattern: it works on the
     * machine where it was written and nowhere else, and the failure elsewhere is a 401 that says nothing
     * about why. The forbidden names are the ways that happens in an Azure SDK.
     */
    const forbidden = [
      "process.env",
      "DefaultAzureCredential",
      "ManagedIdentityCredential",
      "AzureCliCredential",
      "169.254.169.254",
      "MSI_ENDPOINT",
      "IDENTITY_ENDPOINT",
      "az account",
      "~/.azure",
    ];
    for (const name of files) {
      const source = readFileSync(`${dir}${name}`, "utf8");
      for (const needle of forbidden) {
        expect(source, `${name} mentions ${needle}`).not.toContain(needle);
      }
    }
  });
});

describe("the write tools do what their classification claims", () => {
  it("tagging merges, so tags this call did not name survive", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ properties: { tags: { owner: "platform", costCentre: "cc-1" } } }),
    ) as unknown as typeof fetch;

    const outcome = (await run("azure_tag_resource", fetchImpl, {
      resourceId: VM,
      tags: { owner: "platform" },
    })) as { ok: true; data: { existingTagsKept: boolean } };

    expect(outcome.ok).toBe(true);
    const [url, init] = calls(fetchImpl)[0]!;
    expect(init.method).toBe("PATCH");
    expect(url).toContain("/providers/Microsoft.Resources/tags/default");
    /**
     * `Merge`, not `Replace` — the difference between `confirms()` and `destroys()`.
     *
     * `Replace` deletes every tag not named in the request. Tags carry cost attribution and, in many
     * organisations, the input to policy governing whether a resource may exist. A tool that quietly dropped
     * them would be misclassified, so the classification is checked here rather than assumed.
     */
    expect(JSON.parse(init.body as string)).toEqual({ operation: "Merge", properties: { tags: { owner: "platform" } } });
    expect(outcome.data.existingTagsKept).toBe(true);
  });

  it("refuses a tag name Azure would reject, naming the tag", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = failed(await run("azure_tag_resource", fetchImpl, { resourceId: VM, tags: { "a/b": "x" } }));
    expect(outcome.error.message).toContain("a/b");
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it("restarts only the types whose restart endpoint is known", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 202 })) as unknown as typeof fetch;
    const outcome = (await run("azure_restart_resource", fetchImpl, { resourceId: VM })) as {
      ok: true;
      data: { restarted: boolean; note: string };
    };
    expect(outcome.ok).toBe(true);
    const [url, init] = calls(fetchImpl)[0]!;
    expect(init.method).toBe("POST");
    expect(url).toContain("/restart?api-version=2024-07-01");
    // A 202 is an accepted request, not a healthy resource. The result says so rather than implying otherwise.
    expect(outcome.data.note).toMatch(/asynchronously/);

    const unknown = vi.fn() as unknown as typeof fetch;
    const refused = failed(
      await run("azure_restart_resource", unknown, {
        resourceId: `/subscriptions/${SUB}/resourceGroups/prod/providers/Microsoft.Sql/servers/db-01`,
      }),
    );
    expect(refused.error.code).toBe("invalid_input");
    expect(refused.error.message).toContain("Microsoft.Sql/servers");
    // The important half: an unknown type is refused *before* a POST that might mean something worse than a
    // restart on that provider.
    expect(calls(unknown)).toHaveLength(0);
  });

  it("every restartable type has a role, and typeOf lowercases for comparison", () => {
    for (const [type, entry] of Object.entries(RESTART_ROLES)) {
      expect(type, "the key must be lowercased, since it is looked up that way").toBe(type.toLowerCase());
      expect(entry.role).not.toBe("");
      expect(entry.apiVersion).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
    expect(typeOf(VM)).toBe("microsoft.compute/virtualmachines");
    expect(RESTART_ROLES[typeOf(VM)]).toBeDefined();
  });
});

describe("reads are scoped and filtered safely", () => {
  it("a resource type goes into the OData filter only after validation", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] })) as unknown as typeof fetch;
    const outcome = failed(
      await run("azure_list_resources", fetchImpl, {
        subscriptionId: SUB,
        resourceType: "Microsoft.Compute/virtualMachines' or resourceType eq 'Microsoft.KeyVault/vaults",
      }),
    );
    expect(outcome.error.code).toBe("invalid_input");
    expect(calls(fetchImpl)).toHaveLength(0);

    await run("azure_list_resources", fetchImpl, { subscriptionId: SUB, resourceType: "Microsoft.Compute/virtualMachines" });
    expect(new URL(calls(fetchImpl)[0]![0]).searchParams.get("$filter")).toBe(
      "resourceType eq 'Microsoft.Compute/virtualMachines'",
    );
  });

  it("a subscription id that is not a GUID is refused before the call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = failed(await run("azure_list_resource_groups", fetchImpl, { subscriptionId: "prod" }));
    expect(outcome.error.code).toBe("invalid_input");
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it("the activity log filter is built from re-serialised dates, so no caller string reaches it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] })) as unknown as typeof fetch;
    await run("azure_list_activity_log", fetchImpl, { subscriptionId: SUB, hours: 24, resourceGroup: "prod" });
    // Read back through `URL`, because `URLSearchParams` writes a space as `+` and `decodeURIComponent`
    // leaves that alone — asserting on the raw string would be asserting on the encoding, not the filter.
    const filter = new URL(calls(fetchImpl)[0]![0]).searchParams.get("$filter") ?? "";
    expect(filter).toMatch(/eventTimestamp ge '\d{4}-\d{2}-\d{2}T[\d:.]+Z'/);
    expect(filter).toContain("resourceGroupName eq 'prod'");

    // A group name carrying a quote cannot get into the filter, because the charset excludes one.
    const blocked = vi.fn() as unknown as typeof fetch;
    const outcome = failed(
      await run("azure_list_activity_log", blocked, { subscriptionId: SUB, hours: 1, resourceGroup: "prod' or '1' eq '1" }),
    );
    expect(outcome.error.code).toBe("invalid_input");
    expect(calls(blocked)).toHaveLength(0);
  });

  it("the activity log refuses a window past Azure's own retention", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = failed(await run("azure_list_activity_log", fetchImpl, { subscriptionId: SUB, hours: 24 * 91 }));
    expect(outcome.error.code).toBe("invalid_input");
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it("metrics reject an aggregation and a metric name that are not real", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(
      failed(await run("azure_get_metrics", fetchImpl, { resourceId: VM, metricNames: ["Percentage CPU"], aggregation: "Median" })).error.code,
    ).toBe("invalid_input");
    expect(
      failed(await run("azure_get_metrics", fetchImpl, { resourceId: VM, metricNames: ["CPU&api-version=x"] })).error.code,
    ).toBe("invalid_input");
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it("metrics send a bounded timespan and read the aggregation's own field", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        value: [
          {
            name: { value: "Percentage CPU" },
            unit: "Percent",
            timeseries: [{ data: [{ timeStamp: "2026-08-29T12:00:00Z", average: 17.5 }] }],
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const outcome = (await run("azure_get_metrics", fetchImpl, {
      resourceId: VM,
      metricNames: ["Percentage CPU"],
      timespanHours: 2,
    })) as { ok: true; data: { metrics: { points: { value: unknown }[] }[] } };

    const params = new URL(calls(fetchImpl)[0]![0]).searchParams;
    expect(params.get("aggregation")).toBe("Average");
    expect(params.get("timespan")).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\/\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    // `average`, because the aggregation asked for was Average — reading a fixed field would return undefined
    // for every other aggregation and look like a metric with no data.
    expect(outcome.data.metrics[0]!.points[0]!.value).toBe(17.5);
  });
});

describe("roles are declared for every tool — AC-8", () => {
  it("the role table and the toolkit agree exactly", () => {
    expect(Object.keys(TOOL_ROLES).sort()).toEqual([...AZURE_TOOL_NAMES].sort());
    for (const [tool, role] of Object.entries(TOOL_ROLES)) {
      expect(role, tool).not.toBe("");
      // `Owner` would satisfy every row and is the wrong thing to document — see roles.ts.
      expect(role, tool).not.toBe("Owner");
    }
  });
});

describe("include and exclude refuse a name that is not there", () => {
  it("a typo does not silently ship the tool it meant to remove", async () => {
    // Thrown at construction, before anything can call a tool — the earliest point at which the mistake is
    // knowable, and the only point at which refusing it is free.
    expect(() => createAzureToolkit({ credentialRef: "azure", resolver, exclude: ["azure_restart_resourse"] })).toThrow(
      /does not have/,
    );
    const kept = await createAzureToolkit({
      credentialRef: "azure",
      resolver,
      exclude: ["azure_restart_resource"],
    }).listTools(context);
    expect(kept.map((tool) => tool.descriptor.name)).not.toContain("azure_restart_resource");
  });
});
