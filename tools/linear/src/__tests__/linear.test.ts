/**
 * The Linear toolkit — REQ-052 (#224), task #226.
 *
 * AC-3 is the one that matters: Linear is GraphQL-only, and GraphQL reports application errors with HTTP 200.
 * A client that checks only the status reports failure as success.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import { createLinearToolkit, LINEAR_AUTH, LINEAR_TOOL_NAMES, parseIdentifier } from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const toolkit = (fetchImpl: typeof fetch) =>
  createLinearToolkit({
    credentialRef: "linear",
    // A Linear personal API key goes in `Authorization` **without** a `Bearer` prefix.
    resolver: createStaticCredentialResolver({
      linear: { scheme: "custom-header", header: "Authorization", value: "lin_api_test" },
    }),
    fetchImpl,
  });

const run = async (name: string, fetchImpl: typeof fetch, input: unknown) => {
  const tools = await toolkit(fetchImpl).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

/** Answers each GraphQL operation by matching its text, so a test states only what it cares about. */
const graphqlStub = (answers: readonly (readonly [RegExp, unknown])[]) => {
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { query: string; variables: Record<string, unknown> };
    sent.push(body);
    for (const [pattern, data] of answers) {
      if (pattern.test(body.query)) return jsonResponse({ data });
    }
    return jsonResponse({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
};

const TEAMS = { teams: { nodes: [{ id: "team-uuid", key: "ENG", name: "Engineering" }] } };
const STATES = {
  team: {
    states: {
      nodes: [
        { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "s-prog", name: "In Progress", type: "started", position: 2 },
        { id: "s-done", name: "Done", type: "completed", position: 3 },
      ],
    },
  },
};
const ISSUE = {
  id: "issue-uuid",
  identifier: "ENG-123",
  title: "A bug",
  description: "It **fails**",
  url: "https://linear.app/x/ENG-123",
  state: { id: "s-prog", name: "In Progress", type: "started" },
  team: { id: "team-uuid", key: "ENG", name: "Engineering" },
  assignee: { id: "u1", displayName: "Ana" },
  labels: { nodes: [{ name: "retry" }] },
};

describe("the toolkit contract — AC-1, AC-2", () => {
  it("exports its names and declares exactly those tools", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...LINEAR_TOOL_NAMES]);
  });

  it("gates every write and leaves every read ungated", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    for (const read of ["linear_search_issues", "linear_get_issue", "linear_list_teams", "linear_list_states"]) {
      expect(byName.get(read), read).toMatchObject({ effect: "read", approvalPolicy: "never" });
    }
    for (const write of ["linear_create_issue", "linear_update_issue", "linear_comment"]) {
      expect(byName.get(write), write).toMatchObject({
        effect: "external-write",
        approvalPolicy: "always",
        requiresIdempotencyKey: true,
      });
    }
  });

  it("sends the API key raw, with no Bearer prefix", async () => {
    /**
     * The clearest case yet for `schemes` being its own axis. Linear's header name is the standard one and its
     * format is not — sending `Bearer lin_api_…` fails with an authentication error that does not say why.
     */
    expect(LINEAR_AUTH).toEqual({ modes: ["token"], schemes: ["custom-header"] });
    let seen: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Headers }) => {
      seen = new Headers(init?.headers);
      return jsonResponse({ data: TEAMS });
    }) as unknown as typeof fetch;
    await run("linear_list_teams", fetchImpl, {});
    expect(seen?.get("authorization")).toBe("lin_api_test");
  });

  it("has no separate transition tool, because a Linear state is a field", async () => {
    // Jira needs one; Linear does not, and a second tool would be the confusable near-duplicate #210 measured
    // costing real accuracy.
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).not.toContain("linear_transition_issue");
  });
});

describe("the GraphQL envelope is read — AC-3", () => {
  it("treats a 200 carrying errors as a failure and surfaces the first message", async () => {
    /**
     * The bug this prevents. Every HTTP check passes; a client that stops there hands the tool a null `data`,
     * the tool reads a field off it, and the model is told "internal error" about a problem described
     * precisely in a field nobody looked at.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: null, errors: [{ message: "Entity not found: Team" }] }),
    ) as unknown as typeof fetch;
    const result = (await run("linear_list_teams", fetchImpl, {})) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("Entity not found: Team");
  });

  it("says how many errors there were when there was more than one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: null, errors: [{ message: "first" }, { message: "second" }] })) as unknown as typeof fetch;
    const result = (await run("linear_list_teams", fetchImpl, {})) as { ok: false; error: { message: string } };
    expect(result.error.message).toMatch(/first \(and 1 more/);
  });

  it("maps an authentication error in the envelope to unauthorized", async () => {
    // Linear reports permission failures inside the envelope rather than as a status, so the distinction the
    // model needs — is retrying pointless — exists only here.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: null, errors: [{ message: "no", extensions: { code: "AUTHENTICATION_ERROR" } }] }),
    ) as unknown as typeof fetch;
    const result = (await run("linear_list_teams", fetchImpl, {})) as { ok: false; error: { code: string; retryable: boolean } };
    expect(result.error).toMatchObject({ code: "unauthorized", retryable: false });
  });

  it("refuses a response with neither data nor errors rather than guessing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const result = (await run("linear_list_teams", fetchImpl, {})) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("no data and no errors");
  });

  it("treats success:false with no errors as a failure, which the envelope cannot catch", async () => {
    /**
     * A real Linear shape and a genuinely separate case: the GraphQL call *succeeded*, so the envelope reader
     * passes it. Without this the tool reports a created issue that does not exist.
     */
    const { fetchImpl } = graphqlStub([
      [/teams\(first/, TEAMS],
      [/issueCreate/, { issueCreate: { success: false, issue: null } }],
    ]);
    const result = (await run("linear_create_issue", fetchImpl, { team: "ENG", title: "x" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("not created");
  });
});

describe("ids are resolved from human identifiers", () => {
  it("resolves a team key and a state name, sending neither to the API", async () => {
    const { fetchImpl, sent } = graphqlStub([
      [/teams\(first/, TEAMS],
      [/states/, STATES],
      [/issueCreate/, { issueCreate: { success: true, issue: ISSUE } }],
    ]);
    const result = (await run("linear_create_issue", fetchImpl, { team: "eng", title: "x", state: "in progress" })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const mutation = sent.find((body) => body.query.includes("issueCreate"));
    // Both uuids were resolved; neither was in the input, and both names matched case-insensitively.
    expect(mutation?.variables.input).toMatchObject({ teamId: "team-uuid", stateId: "s-prog", title: "x" });
  });

  it("names the team keys that exist when one does not", async () => {
    const { fetchImpl } = graphqlStub([[/teams\(first/, TEAMS]]);
    const result = (await run("linear_create_issue", fetchImpl, { team: "OPS", title: "x" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("The keys are: ENG");
  });

  it("names the states that exist when one does not, and says states are per team", async () => {
    const { fetchImpl } = graphqlStub([
      [/teams\(first/, TEAMS],
      [/states/, STATES],
    ]);
    const result = (await run("linear_create_issue", fetchImpl, { team: "ENG", title: "x", state: "Shipped" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("Todo, In Progress, Done");
    expect(result.error.message).toContain("per team");
  });

  it("parses ENG-123 and rejects what is not an identifier", () => {
    expect(parseIdentifier("ENG-123")).toEqual({ team: "ENG", number: 123 });
    expect(parseIdentifier(" eng-7 ")).toEqual({ team: "ENG", number: 7 });
    for (const bad of ["123", "ENG", "ENG-", "-1", "ENG 123"]) {
      expect(() => parseIdentifier(bad), bad).toThrow(/TEAM-number/);
    }
  });

  it("says an issue may be invisible rather than absent", async () => {
    const { fetchImpl } = graphqlStub([[/issues\(filter/, { issues: { nodes: [] } }]]);
    const result = (await run("linear_get_issue", fetchImpl, { identifier: "ENG-999" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("cannot see its team");
  });

  it("returns the state type, which is what says whether a custom state counts as done", async () => {
    const { fetchImpl } = graphqlStub([[/issues\(filter/, { issues: { nodes: [ISSUE] } }]]);
    const result = (await run("linear_get_issue", fetchImpl, { identifier: "ENG-123" })) as {
      data: { state: string; stateType: string; description: string };
    };
    expect(result.data).toMatchObject({ state: "In Progress", stateType: "started" });
    // Markdown natively — no conversion module, unlike Jira's ADF.
    expect(result.data.description).toBe("It **fails**");
  });

  it("orders states by position, not by name", async () => {
    const { fetchImpl } = graphqlStub([
      [/teams\(first/, TEAMS],
      [/states/, { team: { states: { nodes: [{ name: "Done", type: "completed", position: 3 }, { name: "Todo", type: "unstarted", position: 1 }] } } }],
    ]);
    const result = (await run("linear_list_states", fetchImpl, { team: "ENG" })) as { data: { states: { name: string }[] } };
    expect(result.data.states.map((state) => state.name)).toEqual(["Todo", "Done"]);
  });
});

describe("updates change only what was asked", () => {
  it("refuses an update with nothing to change", async () => {
    const { fetchImpl } = graphqlStub([[/issues\(filter/, { issues: { nodes: [ISSUE] } }]]);
    const result = (await run("linear_update_issue", fetchImpl, { identifier: "ENG-123" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("nothing to change");
  });

  it("resolves a state name against the issue's own team", async () => {
    const { fetchImpl, sent } = graphqlStub([
      [/issues\(filter/, { issues: { nodes: [ISSUE] } }],
      [/states/, STATES],
      [/issueUpdate/, { issueUpdate: { success: true, issue: ISSUE } }],
    ]);
    const result = (await run("linear_update_issue", fetchImpl, { identifier: "ENG-123", state: "Done" })) as {
      ok: true;
      data: { changed: string[] };
    };
    expect(result.ok).toBe(true);
    // The team came from the issue, not from the caller — states are per team and the caller named neither.
    expect(sent.find((body) => body.query.includes("states"))?.variables.teamId).toBe("team-uuid");
    expect(sent.find((body) => body.query.includes("issueUpdate"))?.variables.input).toMatchObject({ stateId: "s-done" });
    expect(result.data.changed).toEqual(["stateId"]);
  });

  it("distinguishes unassigning from not supplying an assignee", async () => {
    const { fetchImpl, sent } = graphqlStub([
      [/issues\(filter/, { issues: { nodes: [ISSUE] } }],
      [/issueUpdate/, { issueUpdate: { success: true, issue: ISSUE } }],
    ]);
    await run("linear_update_issue", fetchImpl, { identifier: "ENG-123", assigneeId: null });
    expect((sent.find((body) => body.query.includes("issueUpdate"))?.variables.input as { assigneeId: unknown }).assigneeId).toBeNull();
  });
});

describe("search is honest about what it matched", () => {
  it("says text matching was applied to the fetched page, not the workspace", async () => {
    /**
     * Linear's `IssueFilter` has no free-text field — full-text search is a separate connection with a
     * different shape. Filtering the fetched page is defensible; implying it searched everything is not.
     */
    const { fetchImpl } = graphqlStub([[/issues\(filter/, { issues: { nodes: [ISSUE], pageInfo: { hasNextPage: true } } }]]);
    const result = (await run("linear_search_issues", fetchImpl, { query: "bug", team: "ENG" })) as {
      data: { issues: unknown[]; truncated: boolean; note: string };
    };
    expect(result.data.issues).toHaveLength(1);
    expect(result.data.truncated).toBe(true);
    expect(result.data.note).toContain("not to every issue in the workspace");
  });

  it("omits the note when no text filter was applied, because nothing was narrowed", async () => {
    const { fetchImpl } = graphqlStub([[/issues\(filter/, { issues: { nodes: [ISSUE], pageInfo: { hasNextPage: false } } }]]);
    const result = (await run("linear_search_issues", fetchImpl, { team: "ENG" })) as { data: { note?: string } };
    expect(result.data.note).toBeUndefined();
  });
});

describe("failures and credentials — AC-6, AC-7", () => {
  it("classifies 429 and 401 the way the runtime expects", async () => {
    for (const [status, code, retryable] of [
      [429, "rate_limited", true],
      [401, "unauthorized", false],
    ] as const) {
      const fetchImpl = vi.fn(async () => jsonResponse({ message: "x" }, status)) as unknown as typeof fetch;
      const result = (await run("linear_list_teams", fetchImpl, {})) as { ok: false; error: { code: string; retryable: boolean } };
      expect(result.error, String(status)).toMatchObject({ code, retryable });
    }
  });

  it("reads no environment variable anywhere in the package source", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const source = readFileSync(`${here}../index.ts`, "utf8");
    expect(source).not.toMatch(/process\s*\.\s*env/);
    expect(source).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
  });

  it("resolves the credential on every call, not once at construction", async () => {
    let resolved = 0;
    const provider = createLinearToolkit({
      credentialRef: "linear",
      resolver: {
        async resolve() {
          resolved += 1;
          return { scheme: "custom-header", header: "Authorization", value: `k${resolved}` };
        },
      },
      fetchImpl: vi.fn(async () => jsonResponse({ data: TEAMS })) as unknown as typeof fetch,
    });
    const tools = await provider.listTools(context);
    const tool = tools.find((t) => t.descriptor.name === "linear_list_teams");
    await tool?.execute({ context, input: {} });
    await tool?.execute({ context, input: {} });
    expect(resolved).toBe(2);
  });
});
