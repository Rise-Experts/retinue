/**
 * Link tracking (#424).
 *
 * `short_links` and `link_clicks` were live and invisible to the agent, so the assistant could answer
 * how far a post reached and not whether it drove anything. These assert the two things a tool layer
 * can get wrong on the way to that answer: what reaches the service, and what comes back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  asId,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import {
  LINK_TOOL_FACTORIES,
  LINK_TOOL_NAMES,
  createTrackedLinkTool,
  getLinkPerformanceTool,
  listTrackedLinksTool,
  type LinkPerformance,
  type ShareFlowServices,
  type ShareFlowToolFactory,
  type TrackedLink,
} from "../../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

const link = (over: Partial<TrackedLink> = {}): TrackedLink =>
  ({
    id: "l1",
    slug: "k3f9xqr",
    url: "https://chorus.test/l/k3f9xqr",
    destinationUrl: "https://northwind.studio/spring",
    title: "Spring sale",
    createdAt: "2026-09-01T09:00:00.000Z",
    clicks: 42,
    ...over,
  }) as TrackedLink;

const performance = (over: Partial<LinkPerformance> = {}): LinkPerformance =>
  ({
    linkId: "l1",
    slug: "k3f9xqr",
    title: "Spring sale",
    destinationUrl: "https://northwind.studio/spring",
    clicks: 31,
    referrers: [
      { referrer: "linkedin.com", clicks: 20 },
      { referrer: "direct", clicks: 11 },
    ],
    countries: [{ country: "DE", clicks: 31 }],
    ...over,
  }) as LinkPerformance;

type Options = {
  links?: () => readonly TrackedLink[];
  performance?: () => readonly LinkPerformance[];
  created?: () => TrackedLink;
  createFails?: () => never;
};

let calls: { method: string; args: Record<string, unknown> }[];

const services = (o: Options = {}): ShareFlowServices =>
  ({
    links: {
      async listTrackedLinks(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "listTrackedLinks", args });
        return o.links?.() ?? [link()];
      },
      async getLinkPerformance(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "getLinkPerformance", args });
        return o.performance?.() ?? [performance()];
      },
      async createTrackedLink(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "createTrackedLink", args });
        if (o.createFails) o.createFails();
        return o.created?.() ?? link({ clicks: 0 });
      },
    },
  }) as unknown as ShareFlowServices;

const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;

let idempotency: IdempotencyStore;
let counter = 0;

const build = (factory: ShareFlowToolFactory, o: Options = {}): Tool =>
  factory.build({ services: services(o), deps: { authorization: allowAll, idempotency } });

const run = (tool: Tool, input: unknown, key?: string): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key ?? `k${(counter += 1)}` });

const dataOf = (result: ToolResult): Record<string, unknown> =>
  (result as { data: Record<string, unknown> }).data;

beforeEach(() => {
  calls = [];
  counter = 0;
  idempotency = createMemoryIdempotencyStore();
});

describe("the catalogue", () => {
  it("is exactly the three tools this SPEC adds", () => {
    expect([...LINK_TOOL_NAMES]).toEqual(["list_tracked_links", "get_link_performance", "create_tracked_link"]);
    expect(LINK_TOOL_FACTORIES).toHaveLength(LINK_TOOL_NAMES.length);
  });

  /**
   * `create_tracked_link` is `internal-write` and the other two are reads — #424's second acceptance.
   * The effect is what decides whether a call needs an approval, so it is asserted rather than assumed:
   * classified higher, every link needs approving, which is the friction that stops anyone attributing
   * anything; classified lower, a write would run ungated.
   */
  it("classifies the write as internal-write and the reads as reads", () => {
    const effects = LINK_TOOL_FACTORIES.map((f) => {
      const tool = build(f);
      return [tool.descriptor.name, tool.descriptor.effect];
    });
    expect(effects).toEqual([
      ["list_tracked_links", "read"],
      ["get_link_performance", "read"],
      ["create_tracked_link", "internal-write"],
    ]);
  });
});

describe("list_tracked_links", () => {
  it("returns the link with the full URL, not just the slug", async () => {
    const data = dataOf(await run(build(listTrackedLinksTool), {}));
    expect(data["links"]).toEqual([
      {
        linkId: "l1",
        url: "https://chorus.test/l/k3f9xqr",
        slug: "k3f9xqr",
        destinationUrl: "https://northwind.studio/spring",
        title: "Spring sale",
        clicks: 42,
        createdAt: "2026-09-01T09:00:00.000Z",
      },
    ]);
  });

  it("passes an attribution filter through to the service", async () => {
    await run(build(listTrackedLinksTool), { postId: "p9", limit: 5 });
    expect(calls[0]!.args).toMatchObject({ postId: "p9", limit: 5 });
  });

  it("omits attribution fields that are absent rather than sending null", async () => {
    await run(build(listTrackedLinksTool), {});
    expect(calls[0]!.args).not.toHaveProperty("postId");
    expect(calls[0]!.args).not.toHaveProperty("campaignId");
  });

  it("carries attribution back when the link has it", async () => {
    const data = dataOf(
      await run(build(listTrackedLinksTool, { links: () => [link({ postId: "p9" as never })] }), {}),
    );
    expect((data["links"] as Record<string, unknown>[])[0]).toMatchObject({ postId: "p9" });
  });
});

describe("get_link_performance", () => {
  /**
   * The window is required, and this is the assertion that keeps it so.
   *
   * "How many clicks did this get" reads as a question about recent behaviour. Answered from all of
   * history it is a different answer to the same sentence, and nothing in the reply would say which
   * one the model got.
   */
  it("refuses without a period", async () => {
    const result = await run(build(getLinkPerformanceTool), { limit: 5 });
    expect((result as { ok?: boolean }).ok).not.toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("echoes the period it answered for", async () => {
    const data = dataOf(await run(build(getLinkPerformanceTool), { since: "2026-09-06" }));
    expect(data["period"]).toEqual({ since: "2026-09-06" });
  });

  it("carries referrers and countries through unchanged", async () => {
    const data = dataOf(await run(build(getLinkPerformanceTool), { since: "2026-09-06" }));
    const first = (data["links"] as Record<string, unknown>[])[0]!;
    expect(first["referrers"]).toEqual([
      { referrer: "linkedin.com", clicks: 20 },
      { referrer: "direct", clicks: 11 },
    ]);
    expect(first["countries"]).toEqual([{ country: "DE", clicks: 31 }]);
  });

  /** The question the SPEC exists for: what a specific post drove. */
  it("filters by post so 'what did this post drive' is answerable", async () => {
    await run(build(getLinkPerformanceTool), { since: "2026-09-06", postId: "p9" });
    expect(calls[0]!.args).toMatchObject({ postId: "p9", since: "2026-09-06" });
  });
});

describe("create_tracked_link", () => {
  it("passes the destination and attribution, and returns the minted URL", async () => {
    const data = dataOf(
      await run(build(createTrackedLinkTool), {
        destinationUrl: "northwind.studio/spring",
        title: "Spring sale",
        postId: "p9",
      }),
    );
    expect(calls[0]!.args).toMatchObject({
      destinationUrl: "northwind.studio/spring",
      title: "Spring sale",
      postId: "p9",
    });
    expect(data["url"]).toBe("https://chorus.test/l/k3f9xqr");
    expect(data["clicks"]).toBe(0);
  });

  /** Normalisation is the service's, not the tool's — one normaliser, or two that disagree. */
  it("does not normalise the destination itself", async () => {
    await run(build(createTrackedLinkTool), { destinationUrl: "  northwind.studio/spring  " });
    expect(calls[0]!.args["destinationUrl"]).toBe("northwind.studio/spring");
  });

  it("carries an idempotency key, so a retried call cannot mint a second link", async () => {
    await run(build(createTrackedLinkTool), { destinationUrl: "northwind.studio" }, "same-key");
    expect(calls[0]!.args).toHaveProperty("idempotencyKey");
  });

  it("rejects an input it does not know", async () => {
    const result = await run(build(createTrackedLinkTool), { destinationUrl: "x.test", slug: "chosen" });
    expect((result as { ok?: boolean }).ok).not.toBe(true);
    // A caller-supplied slug is a way to find out whether another tenant's link exists.
    expect(calls).toHaveLength(0);
  });
});
