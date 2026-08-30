/**
 * The full GitHub surface — REQ-051 (#222), task #223.
 *
 * #214's file tests the *pattern* every toolkit copies. This one tests what is new at 44 tools: selection at
 * wiring time, a GraphQL envelope that reports failure as success, and id resolution from human identifiers.
 *
 * Those three are the risk. The REST tools are repetitive once one of each shape works, and the two that are
 * not repetitive — `github_write_file`, which looks up its own sha, and Group C, which resolves five kinds of
 * node id — get their own cases.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@retinue/agentkit";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import { createGitHubToolkit, fieldValueFor, GITHUB_TOOL_NAMES, parseIssueRef, select } from "../index.js";

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

const toolkit = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  createGitHubToolkit({
    credentialRef: "github",
    resolver: createStaticCredentialResolver({ github: "ghp_test" }),
    fetchImpl,
    ...extra,
  });

const toolNamed = async (name: string, fetchImpl: typeof fetch) => {
  const tools = await toolkit(fetchImpl).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
};

const run = async (name: string, fetchImpl: typeof fetch, input: unknown) => {
  const tool = await toolNamed(name, fetchImpl);
  return tool.execute({ context, input });
};

describe("the surface is complete and classified — AC-1, AC-2", () => {
  it("declares 44 tools and GITHUB_TOOL_NAMES names them in order", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools).toHaveLength(44);
    // Order too, not just membership: a tool added to a group and forgotten in the list is then a failure
    // rather than a divergence that a set comparison would hide.
    expect(tools.map((t) => t.descriptor.name)).toEqual([...GITHUB_TOOL_NAMES]);
  });

  it("gates every write and names the three that cannot be undone", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const writes = tools.filter((t) => t.descriptor.effect !== "read");
    expect(writes).toHaveLength(22);
    // #228: the effect *derives* both of these. Asserting them proves nothing was overridden.
    for (const write of writes) {
      expect(write.descriptor.approvalPolicy, write.descriptor.name).toBe("always");
      expect(write.descriptor.requiresIdempotencyKey, write.descriptor.name).toBe(true);
    }
    expect(tools.filter((t) => t.descriptor.effect === "destructive").map((t) => t.descriptor.name)).toEqual([
      "github_merge_pull_request",
      "github_delete_file",
      // On the board, not the issue — which the description has to say, because the words are close and the
      // acts are not.
      "github_remove_project_item",
    ]);
  });

  it("says in every write's description that it needs approval", async () => {
    // The gate is enforced by the registry; the description is how the model knows before calling. A write that
    // does not say so produces a confusing pause.
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    for (const tool of tools.filter((t) => t.descriptor.effect !== "read")) {
      expect(tool.descriptor.description.toLowerCase(), tool.descriptor.name).toContain("approval");
    }
  });
});

describe("selection happens at wiring time — AC-3", () => {
  it("ships only what include names", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch, { include: ["github_search_issues"] }).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual(["github_search_issues"]);
  });

  it("ships everything but what exclude names", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch, { exclude: ["github_delete_file", "github_merge_pull_request"] }).listTools(context);
    expect(tools).toHaveLength(42);
    expect(tools.map((t) => t.descriptor.name)).not.toContain("github_delete_file");
  });

  it("refuses a typo'd exclusion instead of shipping the tool", () => {
    /**
     * The failure this exists for. `github_serch_issues` silently ignored means the operator believes they
     * removed a tool they did not remove — and for `exclude` that belief is a security one.
     */
    expect(() => toolkit(vi.fn() as unknown as typeof fetch, { exclude: ["github_serch_issues"] })).toThrow(
      /github_serch_issues/,
    );
  });

  it("suggests the name that was meant", () => {
    expect(() => toolkit(vi.fn() as unknown as typeof fetch, { exclude: ["github_serch_issues"] })).toThrow(
      /Did you mean.*github_search_issues/,
    );
  });

  it("refuses a typo'd inclusion too, not only the dangerous direction", () => {
    // A check that guards only the dangerous direction is the one nobody trusts.
    expect(() => toolkit(vi.fn() as unknown as typeof fetch, { include: ["github_get_isue"] })).toThrow(/github_get_isue/);
  });

  it("refuses include and exclude together rather than picking one", () => {
    expect(() => toolkit(vi.fn() as unknown as typeof fetch, { include: ["github_get_file"], exclude: ["github_delete_file"] })).toThrow(
      /Pick one/,
    );
  });

  it("fails at construction, not at the first turn that needed the tool", async () => {
    // `listTools` is never reached. A boot-time failure is one somebody sees in CI; a first-turn failure is one
    // a customer sees.
    expect(() => toolkit(vi.fn() as unknown as typeof fetch, { include: ["nope"] })).toThrow();
    expect(select([], {})).toEqual([]);
  });
});

describe("the GraphQL envelope is read — AC-4", () => {
  it("treats a 200 carrying errors as a failure and surfaces the first message", async () => {
    /**
     * The bug this prevents. GraphQL answers `200 OK` with `{ data: null, errors: [...] }`: every HTTP check
     * passes, and a transport that stops there hands the tool a null `data` and reports success. The tool then
     * reads a field off null, throws a TypeError, and the model is told "internal error" about a problem that
     * was described precisely in a field nobody looked at. Exactly Slack's `ok: false` (#214).
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: null, errors: [{ message: "Could not resolve to a ProjectV2 with the number 99." }] }),
    ) as unknown as typeof fetch;
    // `defineTool` catches and returns `{ ok: false, error }` rather than rejecting — a tool failure is data
    // the model reads, not an exception the host handles.
    const result = (await run("github_list_projects", fetchImpl, { owner: "acme" })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/Could not resolve to a ProjectV2/);
  });

  it("says how many errors there were when there was more than one", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: null, errors: [{ message: "first" }, { message: "second" }] }),
    ) as unknown as typeof fetch;
    const result = (await run("github_list_projects", fetchImpl, { owner: "acme" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toMatch(/first \(and 1 more/);
  });

  it("maps FORBIDDEN to unauthorized, so the model stops rather than retrying", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] }),
    ) as unknown as typeof fetch;
    const result = (await run("github_list_projects", fetchImpl, { owner: "acme" })) as { ok: false; error: { code: string; retryable: boolean } };
    expect(result.error.code).toBe("unauthorized");
    expect(result.error.retryable).toBe(false);
  });

  it("refuses a response with neither data nor errors rather than guessing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const result = (await run("github_list_projects", fetchImpl, { owner: "acme" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toMatch(/no data and no errors/);
  });

  it("tolerates NOT_FOUND only for the half of a two-way query that missed", async () => {
    /**
     * A login is an organisation or a user, and Projects v2 hangs off both. Asking the caller which pushes an
     * implementation detail into the schema — so the query asks both ways and GitHub reports NOT_FOUND for the
     * one that does not exist. Tolerated *only* when some data came back.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { organization: null, user: { projectsV2: { totalCount: 1, nodes: [{ id: "P_1", number: 3, title: "Roadmap", url: "u", closed: false }] } } },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Organization with the login of 'octocat'." }],
      }),
    ) as unknown as typeof fetch;
    const result = (await run("github_list_projects", fetchImpl, { owner: "octocat" })) as { ok: boolean; data: { projects: unknown[] } };
    expect(result.ok).toBe(true);
    expect(result.data.projects).toEqual([{ number: 3, title: "Roadmap", url: "u", closed: false }]);
  });

  it("still fails when every alias missed, so a wrong login is not an empty answer", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { organization: null, user: null },
        errors: [{ type: "NOT_FOUND", message: "no such owner" }],
      }),
    ) as unknown as typeof fetch;
    const result = (await run("github_list_projects", fetchImpl, { owner: "nobody" })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/no such owner/);
  });
});

describe("Projects v2 resolves ids from human identifiers — AC-5", () => {
  const PROJECT = {
    id: "PVT_1",
    number: 5,
    title: "Board",
    url: "https://github.com/orgs/acme/projects/5",
    closed: false,
    fields: {
      totalCount: 2,
      nodes: [
        { __typename: "ProjectV2SingleSelectField", id: "F_status", name: "Status", options: [{ id: "O_todo", name: "Todo" }, { id: "O_prog", name: "In Progress" }, { id: "O_done", name: "Done" }] },
        { __typename: "ProjectV2Field", id: "F_est", name: "Estimate", dataType: "NUMBER" },
      ],
    },
    items: {
      totalCount: 1,
      nodes: [{ id: "I_1", content: { __typename: "Issue", number: 42, title: "A bug", repository: { nameWithOwner: "acme/app" } } }],
    },
  };

  /** Answers the project query, then records the mutation so the resolved ids can be inspected. */
  const projectFetch = () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const sent = JSON.parse(init?.body ?? "{}") as { query: string; variables: unknown };
      bodies.push(sent);
      if (sent.query.includes("mutation")) return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "I_1" } } } });
      return jsonResponse({ data: { organization: { projectV2: PROJECT }, user: null } });
    }) as unknown as typeof fetch;
    return { fetchImpl, bodies };
  };

  it("sets a field from a login, a number, owner/repo#n, and two names", async () => {
    const { fetchImpl, bodies } = projectFetch();
    const result = (await run("github_set_project_field", fetchImpl, {
      owner: "acme",
      number: 5,
      issue: "acme/app#42",
      field: "Status",
      value: "Done",
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    // Every one of the four ids in that mutation was resolved, and none was in the input.
    const mutation = bodies.find((b) => (b as { query: string }).query.includes("mutation")) as { variables: Record<string, unknown> };
    expect(mutation.variables).toEqual({
      projectId: "PVT_1",
      itemId: "I_1",
      fieldId: "F_status",
      value: { singleSelectOptionId: "O_done" },
    });
  });

  it("matches a field and an option case-insensitively", async () => {
    const { fetchImpl } = projectFetch();
    const result = (await run("github_set_project_field", fetchImpl, { owner: "acme", number: 5, issue: "acme/app#42", field: "status", value: "done" })) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("names the valid options when the value does not match", async () => {
    const { fetchImpl } = projectFetch();
    const result = (await run("github_set_project_field", fetchImpl, { owner: "acme", number: 5, issue: "acme/app#42", field: "Status", value: "Dnoe" })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    // The whole point of AC-5: a model told "no such option" guesses again; told the options, it picks one.
    expect(result.error.message).toContain("Todo, In Progress, Done");
  });

  it("names the valid fields when the field does not match", async () => {
    const { fetchImpl } = projectFetch();
    const result = (await run("github_set_project_field", fetchImpl, { owner: "acme", number: 5, issue: "acme/app#42", field: "Staus", value: "Done" })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("Status, Estimate");
  });

  it("says what is on the board when the issue is not", async () => {
    const { fetchImpl } = projectFetch();
    const result = (await run("github_set_project_field", fetchImpl, { owner: "acme", number: 5, issue: "acme/app#99", field: "Status", value: "Done" })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("acme/app#42");
    expect(result.error.message).toContain("github_add_project_item");
  });

  it("exposes the field options a model needs before setting one", async () => {
    const { fetchImpl } = projectFetch();
    const result = (await run("github_get_project", fetchImpl, { owner: "acme", number: 5 })) as {
      data: { fields: { name: string; type: string; options?: string[] }[] };
    };
    expect(result.data.fields).toEqual([
      { name: "Status", type: "single-select", options: ["Todo", "In Progress", "Done"] },
      { name: "Estimate", type: "number" },
    ]);
  });

  it("says which project numbers exist when the number does not", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { organization: { projectV2: null }, user: null } })) as unknown as typeof fetch;
    const result = (await run("github_get_project", fetchImpl, { owner: "acme", number: 99 })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("github_list_projects");
  });

  it("reports removal as off-the-board and says the issue survives", async () => {
    const { fetchImpl } = projectFetch();
    const result = (await run("github_remove_project_item", fetchImpl, { owner: "acme", number: 5, issue: "acme/app#42" })) as {
      data: { issueStillExists: boolean };
    };
    expect(result.data.issueStillExists).toBe(true);
  });
});

describe("the value mapping and the reference parser", () => {
  it("maps each field type to the one key GraphQL accepts", () => {
    // A wrong key here typechecks and does nothing, which is the defect shape this repository keeps finding —
    // so the mapping is tested directly rather than only through a mutation.
    expect(fieldValueFor({ __typename: "ProjectV2Field", id: "f", name: "Notes", dataType: "TEXT" }, "hello")).toEqual({ text: "hello" });
    expect(fieldValueFor({ __typename: "ProjectV2Field", id: "f", name: "Estimate", dataType: "NUMBER" }, "3")).toEqual({ number: 3 });
    expect(fieldValueFor({ __typename: "ProjectV2Field", id: "f", name: "Due", dataType: "DATE" }, "2026-01-02")).toEqual({ date: "2026-01-02" });
  });

  it("refuses a number that is not one, and a date that is not ISO, naming the field", () => {
    expect(() => fieldValueFor({ __typename: "ProjectV2Field", id: "f", name: "Estimate", dataType: "NUMBER" }, "big")).toThrow(/"Estimate" takes a number/);
    expect(() => fieldValueFor({ __typename: "ProjectV2Field", id: "f", name: "Due", dataType: "DATE" }, "2 Jan")).toThrow(/YYYY-MM-DD/);
  });

  it("refuses an iteration field rather than guessing an id", () => {
    expect(() => fieldValueFor({ __typename: "ProjectV2IterationField", id: "f", name: "Sprint", dataType: "ITERATION" }, "Sprint 3")).toThrow(
      /cannot set/,
    );
  });

  it("parses owner/repo#number and rejects what is not one", () => {
    expect(parseIssueRef("acme/app#42")).toEqual({ owner: "acme", repo: "app", number: 42 });
    expect(parseIssueRef("  acme/app#42 ")).toEqual({ owner: "acme", repo: "app", number: 42 });
    expect(() => parseIssueRef("#42")).toThrow(/owner\/repo#number/);
    expect(() => parseIssueRef("acme/app")).toThrow(/owner\/repo#number/);
  });
});

describe("writes that resolve their own state", () => {
  it("creates a file when it does not exist and updates it when it does", async () => {
    const seen: { method?: string; body?: string }[] = [];
    const exists = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      seen.push({ method: init?.method ?? "GET", ...(init?.body === undefined ? {} : { body: init.body }) });
      if ((init?.method ?? "GET") === "GET") return jsonResponse({ sha: "old_sha", path: "a.txt" });
      return jsonResponse({ content: { sha: "new_sha", html_url: "u" }, commit: { sha: "c1" } });
    }) as unknown as typeof fetch;
    const updated = (await run("github_write_file", exists, { owner: "a", repo: "b", path: "a.txt", content: "x", message: "m" })) as {
      data: { created: boolean };
    };
    // The sha the model never carried.
    expect(updated.data.created).toBe(false);
    expect(JSON.parse(seen[1]?.body ?? "{}")).toMatchObject({ sha: "old_sha" });

    const absent = vi.fn(async (url: unknown, init?: { method?: string }) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({ message: "Not Found" }, 404);
      return jsonResponse({ content: { sha: "new_sha", html_url: "u" }, commit: { sha: "c1" } });
    }) as unknown as typeof fetch;
    const created = (await run("github_write_file", absent, { owner: "a", repo: "b", path: "new.txt", content: "x", message: "m" })) as {
      data: { created: boolean };
    };
    expect(created.data.created).toBe(true);
  });

  it("does not read a 403 as 'the file is new'", async () => {
    /**
     * The reason the catch in `github_write_file` is narrow. Catching broadly would turn "no permission to
     * read" into the create case, and the write then fails with a 422 about a missing sha — a confusing error
     * about the wrong thing.
     */
    const forbidden = vi.fn(async () => jsonResponse({ message: "Forbidden" }, 403)) as unknown as typeof fetch;
    const result = (await run("github_write_file", forbidden, { owner: "a", repo: "b", path: "a.txt", content: "x", message: "m" })) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("unauthorized");
  });

  it("resolves a branch name to a sha when creating a branch", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({ sha: "main_sha" });
      bodies.push(init?.body ?? "");
      return jsonResponse({ ref: "refs/heads/feature" });
    }) as unknown as typeof fetch;
    const result = (await run("github_create_branch", fetchImpl, { owner: "a", repo: "b", name: "feature", from: "main" })) as { ok: boolean };
    expect(result.ok).toBe(true);
    // `from: "main"` is what a model writes; the refs API needs a sha.
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ ref: "refs/heads/feature", sha: "main_sha" });
  });

  it("refuses an update with nothing to change instead of succeeding at nothing", async () => {
    // An empty PATCH succeeds at GitHub and changes nothing, so the model is told the update worked.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("github_update_issue", fetchImpl, { owner: "a", repo: "b", number: 1 })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("nothing to change");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("comments before closing, so a close cannot lose its explanation", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return jsonResponse({ number: 1, state: "closed", state_reason: "completed" });
    }) as unknown as typeof fetch;
    await run("github_close_issue", fetchImpl, { owner: "a", repo: "b", number: 1, reason: "completed", comment: "done" });
    // Comment first: the reverse order can close an issue and then fail to say why.
    expect(calls[0]).toContain("/comments");
    expect(calls[1]).toContain("PATCH https://api.github.com/repos/a/b/issues/1");
  });

  it("requires a body on a REQUEST_CHANGES review, naming the field", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("github_review_pull_request", fetchImpl, { owner: "a", repo: "b", number: 1, event: "REQUEST_CHANGES" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("needs a body");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("failures stay actionable — AC-6", () => {
  it("reports a 403 without a rate-limit signal as unauthorized, not a generic error", async () => {
    // A token that reads code often cannot write a project, and this is the single most common GitHub failure.
    // `unauthorized` stops the model; `provider_error` invites a retry with different arguments.
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Resource not accessible" }, 403)) as unknown as typeof fetch;
    const result = (await run("github_get_issue", fetchImpl, { owner: "a", repo: "b", number: 1 })) as { ok: false; error: { code: string; retryable: boolean; message: string } };
    expect(result.error.code).toBe("unauthorized");
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("scope");
  });

  it("still reports a 429 as a retryable rate limit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "too many" }, 429)) as unknown as typeof fetch;
    const result = (await run("github_get_issue", fetchImpl, { owner: "a", repo: "b", number: 1 })) as { ok: false; error: { code: string; retryable: boolean } };
    expect(result.error.code).toBe("rate_limited");
    expect(result.error.retryable).toBe(true);
  });

  it("reports pagination truncation rather than implying there was no more", async () => {
    // Five pages of 100, all full: the ceiling was hit, and saying so is the difference between "500 commits"
    // and "at least 500 commits".
    const fetchImpl = vi.fn(async () => jsonResponse(Array.from({ length: 100 }, (_, i) => ({ sha: `s${i}`, commit: {} })))) as unknown as typeof fetch;
    const result = (await run("github_list_commits", fetchImpl, { owner: "a", repo: "b", perPage: 100 })) as {
      data: { commits: unknown[]; truncated: boolean };
    };
    expect(result.data.truncated).toBe(true);
    expect(result.data.commits).toHaveLength(500);
  });

  it("says a file is a file rather than reporting an empty directory", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ type: "file", path: "a.txt" })) as unknown as typeof fetch;
    const result = (await run("github_list_directory", fetchImpl, { owner: "a", repo: "b", path: "a.txt" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("github_get_file");
  });

  it("returns the end of a long log and says it truncated", async () => {
    const log = `${"noise\n".repeat(20_000)}FATAL: the actual failure`;
    const fetchImpl = vi.fn(async () => new Response(log, { status: 200 })) as unknown as typeof fetch;
    const result = (await run("github_get_workflow_run_logs", fetchImpl, { owner: "a", repo: "b", jobId: 1 })) as {
      data: { log: string; truncated: boolean };
    };
    expect(result.data.truncated).toBe(true);
    // The tail, not the head: a failure is at the end, and the head is the same npm progress bar every time.
    expect(result.data.log).toContain("FATAL: the actual failure");
  });

  it("does not claim to know the run id a dispatch started", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const result = (await run("github_dispatch_workflow", fetchImpl, { owner: "a", repo: "b", workflow: "ci.yml", ref: "main" })) as {
      data: { dispatched: boolean; note: string };
    };
    expect(result.data.dispatched).toBe(true);
    // GitHub returns 204 with no body. Inventing a run id, or reporting one from a later list call, would
    // sometimes name a different run that started in between.
    expect(result.data.note).toContain("does not return the run id");
  });
});

describe("the gate is the registry's, not the tool's — test step 5", () => {
  /**
   * The registry, not `tool.execute`, is where approval is enforced.
   *
   * Every test above calls `execute` directly, which is the right way to test what a tool *does* and says
   * nothing at all about whether it can be called without a human. So this walks the real path once: a
   * classified write, through a registry with an approval check, with no grant.
   *
   * Once for all 22 writes rather than 22 near-identical cases — the gate reads `descriptor.approvalPolicy`,
   * which the classification test above already pins for every one of them. What this adds is proof that the
   * field is *load-bearing*.
   */
  const registryFor = async (fetchImpl: typeof fetch) => {
    const { createToolRegistry } = await import("@retinue/agentkit/tools");
    return createToolRegistry({
      providers: [toolkit(fetchImpl)],
      // Allows everything, so the only thing that can refuse below is the approval gate.
      authorization: {
        async can() { return { allow: true }; },
        async filterTools(_c: unknown, tools: readonly unknown[]) { return tools; },
        async scope(c: ExecutionContext) { return { tenantId: c.tenantId, roleIds: [] }; },
      } as never,
      // No grant exists for anything, so a policy-classified tool cannot run.
      approval: { async isAllowed() { return false; } } as never,
    });
  };

  it("refuses a classified write with approval_required and never reaches GitHub", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const registry = await registryFor(fetchImpl);
    const result = await registry.execute(context, {
      name: "github_create_issue",
      input: { owner: "a", repo: "b", title: "t" },
      idempotencyKey: "k1",
    } as never);
    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe("approval_required");
    // The important half: the refusal happened before the network, so an unapproved write cannot have
    // half-happened at GitHub.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lets a read through the same registry, so the refusal is the classification and not the wiring", async () => {
    // Without this, a registry that refused everything would pass the test above.
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 1, labels: [], assignees: [] })) as unknown as typeof fetch;
    const registry = await registryFor(fetchImpl);
    const result = await registry.execute(context, { name: "github_get_issue", input: { owner: "a", repo: "b", number: 1 } } as never);
    expect((result as { ok: boolean }).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("refuses every one of the 22 writes, not just the one that was checked", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const registry = await registryFor(fetchImpl);
    const tools = await toolkit(fetchImpl).listTools(context);
    for (const tool of tools.filter((t) => t.descriptor.effect !== "read")) {
      const result = await registry.execute(context, {
        name: tool.descriptor.name,
        input: {},
        idempotencyKey: "k",
      } as never);
      expect((result as { ok: boolean }).ok, tool.descriptor.name).toBe(false);
      expect((result as { error: { code: string } }).error.code, tool.descriptor.name).toBe("approval_required");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
