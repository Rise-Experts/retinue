/**
 * The GitHub toolkit — REQ-047 (#206), task #214.
 *
 * These test the *pattern* as much as the vendor: credentials resolved per call, egress applied, writes gated,
 * pagination honest. Twenty more packages copy this file's shape, so what is asserted here is what the others
 * will be held to.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@retinue/agentkit";
import { bearer, createStaticCredentialResolver } from "@retinue/agentkit/tools";
import type { ExecutionContext } from "@retinue/agentkit";
import { asId } from "@retinue/agentkit";
import { createGitHubToolkit, GITHUB_TOOL_NAMES } from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const toolkit = (fetchImpl: typeof fetch, secrets: Record<string, string> = { github: "ghp_test" }) =>
  createGitHubToolkit({ credentialRef: "github", resolver: createStaticCredentialResolver(secrets), fetchImpl });

const toolNamed = async (name: string, fetchImpl: typeof fetch, secrets?: Record<string, string>) => {
  const tools = await toolkit(fetchImpl, secrets).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
};

describe("the toolkit contract — AC-2", () => {
  it("is a ToolProvider a host registers in one call", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name).sort()).toEqual([...GITHUB_TOOL_NAMES].sort());
  });

  it("declares a category, so preloading by category works", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    for (const tool of tools) expect(tool.descriptor.category).toBe("project");
  });
});

describe("writes are gated by classification — AC-3", () => {
  it("classifies each tool by what it does, not by its name", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    expect(byName.get("github_search_code")).toMatchObject({ effect: "read", approvalPolicy: "never" });
    expect(byName.get("github_create_issue")).toMatchObject({ effect: "external-write", approvalPolicy: "always", requiresIdempotencyKey: true });
    // A merge cannot be undone, and the catalogue has to be able to answer "what can this agent irreversibly do".
    expect(byName.get("github_merge_pull_request")).toMatchObject({ effect: "destructive", approvalPolicy: "always" });
  });
});

describe("credentials are resolved per call, never held — AC-5", () => {
  it("sends the resolved token as a bearer header", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ total_count: 0, items: [] }));
    const tool = await toolNamed("github_search_code", fetchImpl as unknown as typeof fetch);
    await tool.execute({ context, input: { query: "foo" } });
    const headers = new Headers((fetchImpl.mock.calls[0] as unknown[])[1] ? ((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).headers : undefined);
    expect(headers.get("authorization")).toBe("Bearer ghp_test");
  });

  it("resolves on every call, so a rotated token takes effect without a restart", async () => {
    const resolve = vi.fn(async () => bearer("ghp_rotating"));
    const fetchImpl = vi.fn(async () => jsonResponse({ total_count: 0, items: [] }));
    const provider = createGitHubToolkit({ credentialRef: "github", resolver: { resolve }, fetchImpl: fetchImpl as unknown as typeof fetch });
    const tools = await provider.listTools(context);
    const tool = tools.find((t) => t.descriptor.name === "github_search_code")!;
    await tool.execute({ context, input: { query: "a" } });
    await tool.execute({ context, input: { query: "b" } });
    // Twice, not once at construction: a credential read at startup survives its own rotation, and the failure
    // then looks like the vendor rejecting a token that "has not changed".
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("fails with a wiring error when no credential is configured, before any request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const tool = await toolNamed("github_search_code", fetchImpl as unknown as typeof fetch, {});
    const result = await tool.execute({ context, input: { query: "x" } });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads no credential from the environment", () => {
    // The property that makes multi-tenancy possible later without rewriting every toolkit.
    /**
     * Comments stripped first.
     *
     * The module header explains *why* a toolkit must not read `process.env`, and the first version of this test
     * matched that sentence — failing on the documentation that states the rule. Asserting on code rather than
     * on prose is the whole point.
     */
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toContain("process.env");
  });
});

describe("pagination is honest — AC-6", () => {
  it("walks pages and stops when a page is short", async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(page(2)))
      .mockResolvedValueOnce(jsonResponse(page(1)));
    const tool = await toolNamed("github_list_issues", fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ context, input: { owner: "o", repo: "r", perPage: 2 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ truncated: false });
    expect((result.ok ? (result.data as { issues: unknown[] }).issues : []).length).toBe(3);
  });

  it("reports truncation rather than pretending it saw everything", async () => {
    const full = Array.from({ length: 2 }, (_, i) => ({ number: i }));
    const fetchImpl = vi.fn(async () => jsonResponse(full));
    const tool = await toolNamed("github_list_issues", fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ context, input: { owner: "o", repo: "r", perPage: 2 } });
    // A tool that returns page one and says nothing about page two loses data silently: the model concludes
    // there were only that many issues.
    if (result.ok) expect(result.data).toMatchObject({ truncated: true });
  });
});

describe("rate limits are a distinct outcome — AC-6", () => {
  it("says rate limited rather than forbidden, so the model waits instead of retrying differently", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limit exceeded", { status: 429 }));
    const tool = await toolNamed("github_list_issues", fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ context, input: { owner: "o", repo: "r" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(true);
  });
});

describe("egress is the platform's — AC-4", () => {
  it("refuses a base URL the egress policy rejects, without a request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const provider = createGitHubToolkit({
      credentialRef: "github",
      resolver: createStaticCredentialResolver({ github: "t" }),
      // Private address space: the policy refuses it, which is the control on a URL a *model* could influence.
      baseUrl: "http://169.254.169.254",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const tools = await provider.listTools(context);
    const tool = tools.find((t) => t.descriptor.name === "github_list_issues")!;
    const result = await tool.execute({ context, input: { owner: "o", repo: "r" } });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

import { readFileSync } from "node:fs";
