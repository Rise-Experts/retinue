/**
 * `POST /api/tools/:name` — the entry point three capabilities were `partial` for.
 *
 * The gate is the interesting part. A tool's `effect` decides whether the platform requires approval,
 * and the approval loop lives in a **conversation**: a run pauses, a person decides, the run resumes.
 * This route has no run to pause and nobody to ask, so a gated tool called here would execute with the
 * approval step simply absent — a publish nobody confirmed, through an endpoint whose purpose is
 * convenience.
 *
 * So the allowed effects are written as an allow-list and an unrecognised effect is refused. That
 * direction is the whole point: a deny-list would admit a fifth effect the day the platform adds one,
 * silently, and the new kind of dangerous tool would be reachable without approval.
 */
import { describe, expect, it, vi } from "vitest";

import { RPC_ALLOWED_EFFECTS, executeToolCall, toolNameFrom } from "../tool-route.js";

const context = { tenantId: "t1", principalId: "p1", roleIds: ["editor"] } as never;

const registry = (descriptor: Record<string, unknown> | undefined, result?: unknown, throws?: unknown) => {
  const executed: unknown[] = [];
  return {
    executed,
    registry: {
      async learn() {
        return descriptor === undefined ? [] : [descriptor];
      },
      async execute(_context: unknown, call: unknown) {
        executed.push(call);
        if (throws !== undefined) throw throws;
        return result ?? { ok: true, data: { drafted: true } };
      },
    } as never,
  };
};

describe("the path", () => {
  it("matches a tool call and nothing else", () => {
    expect(toolNameFrom("/api/tools/generate_content")).toBe("generate_content");
    expect(toolNameFrom("/api/tools/")).toBeNull();
    expect(toolNameFrom("/api/message")).toBeNull();
    // No traversal, no slashes, no dots: the name goes to the registry, and a name that could contain a
    // path is a name that could mean something else there.
    expect(toolNameFrom("/api/tools/../message")).toBeNull();
    expect(toolNameFrom("/api/tools/a/b")).toBeNull();
    expect(toolNameFrom("/api/tools/generate-content")).toBeNull();
  });
});

describe("the effect gate", () => {
  it("allows read and internal-write, and nothing else", () => {
    /**
     * Asserted as a set rather than by calling each: this is the list that decides what is reachable
     * without approval, so adding to it should fail a test and require a sentence.
     */
    expect([...RPC_ALLOWED_EFFECTS]).toEqual(["read", "internal-write"]);
  });

  it("executes a read tool", async () => {
    const { registry: r, executed } = registry({ name: "generate_content", effect: "read" });
    const outcome = await executeToolCall({ registry: r, context, name: "generate_content", body: { brief: "x" } });
    expect(outcome.status).toBe(200);
    expect(executed).toEqual([{ name: "generate_content", input: { brief: "x" } }]);
  });

  it("executes an internal-write tool, because nothing leaves the tenant", async () => {
    /**
     * `draft_comment_reply` is the case. It writes a drafted reply and puts the comment back into
     * needs-review, and the inventory gives that as the reason it is *not* approval-gated. Refusing it
     * here would refuse a capability the platform considers ungated.
     */
    const { registry: r } = registry({ name: "draft_comment_reply", effect: "internal-write" });
    expect((await executeToolCall({ registry: r, context, name: "draft_comment_reply", body: {} })).status).toBe(200);
  });

  it("refuses an external-write, and says where the approval lives", async () => {
    const { registry: r, executed } = registry({ name: "publish_post_now", effect: "external-write" });
    const outcome = await executeToolCall({ registry: r, context, name: "publish_post_now", body: {} });
    expect(outcome.status).toBe(403);
    // Not executed at all — refused before the call, not after it.
    expect(executed).toEqual([]);
    expect(JSON.stringify(outcome.body)).toContain("/api/message");
  });

  it("refuses a destructive tool", async () => {
    const { registry: r } = registry({ name: "delete_post", effect: "destructive" });
    expect((await executeToolCall({ registry: r, context, name: "delete_post", body: {} })).status).toBe(403);
  });

  it("refuses an effect it does not recognise", async () => {
    /**
     * **The assertion that makes this an allow-list.** A fifth effect added to the platform — and the
     * platform's own notes say a new one silently ungates in three places — must be refused here until
     * somebody decides otherwise. A deny-list would have let it straight through.
     */
    for (const effect of ["irreversible", "spends-money", "", undefined]) {
      const { registry: r, executed } = registry({ name: "something_new", effect });
      const outcome = await executeToolCall({ registry: r, context, name: "something_new", body: {} });
      expect(outcome.status, String(effect)).toBe(403);
      expect(executed, String(effect)).toEqual([]);
    }
  });
});

describe("what the caller gets back", () => {
  it("reads an unauthorized or unknown tool as absent", async () => {
    /**
     * 404 rather than 403, and `learn` rather than the catalogue, because `learn` answers for **this**
     * principal. The registry's own `find` comment makes the point: confirming a tool exists while
     * hiding it from discovery turns the endpoint into an enumeration oracle, and is worse than not
     * hiding it.
     */
    const { registry: r } = registry(undefined);
    expect((await executeToolCall({ registry: r, context, name: "github_merge_pull_request", body: {} })).status).toBe(
      404,
    );
  });

  it("turns a declined result into a 422, not a 200 carrying a failure", async () => {
    /**
     * The old routes answered with a status the caller branched on. A form that reads `200` as success
     * would render a generated post that does not exist, so the status has to agree with `ok`.
     */
    const { registry: r } = registry({ name: "generate_content", effect: "read" }, { ok: false, error: "no brand profile" });
    const outcome = await executeToolCall({ registry: r, context, name: "generate_content", body: {} });
    expect(outcome.status).toBe(422);
    expect(JSON.stringify(outcome.body)).toContain("no brand profile");
  });

  it("passes a refusal's own message through, and hides an unexpected one", async () => {
    /**
     * A refusal says something the caller can act on. An unexpected throw may carry a connection string,
     * so it is logged and answered generically — the distinction being the `code` the platform's errors
     * carry.
     */
    const known = registry({ name: "generate_content", effect: "read" }, undefined, {
      code: "invalid_input",
      message: "brief must not be empty",
    });
    const refused = await executeToolCall({ registry: known.registry, context, name: "generate_content", body: {} });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain("brief must not be empty");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unexpected = registry({ name: "generate_content", effect: "read" }, undefined,
      new Error("connect ECONNREFUSED postgres://user:pw@10.0.0.5:5432"));
    const hidden = await executeToolCall({ registry: unexpected.registry, context, name: "generate_content", body: {} });
    expect(hidden.status).toBe(400);
    expect(JSON.stringify(hidden.body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(hidden.body)).not.toContain("10.0.0.5");
    // Logged rather than swallowed, or nobody could diagnose it.
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("forwards an idempotency key only when the caller sent one", async () => {
    /**
     * A key this route invented would be unique per attempt, so a retry after a timeout would execute
     * twice — the exact failure the key exists to prevent.
     */
    const { registry: r, executed } = registry({ name: "draft_comment_reply", effect: "internal-write" });
    await executeToolCall({ registry: r, context, name: "draft_comment_reply", body: {}, idempotencyKey: "abc" });
    expect((executed[0] as { idempotencyKey?: string }).idempotencyKey).toBe("abc");

    const plain = registry({ name: "draft_comment_reply", effect: "internal-write" });
    await executeToolCall({ registry: plain.registry, context, name: "draft_comment_reply", body: {} });
    expect(plain.executed[0]).not.toHaveProperty("idempotencyKey");
  });

  it("passes the body straight through as the tool's input", async () => {
    // No envelope: the old routes had none, and the Next app posts its fields directly. The registry
    // validates against the tool's own schema, so a wrong field is the schema's message.
    const { registry: r, executed } = registry({ name: "propose_post_angles", effect: "read" });
    await executeToolCall({ registry: r, context, name: "propose_post_angles", body: { topic: "oat milk", count: 3 } });
    expect((executed[0] as { input: unknown }).input).toEqual({ topic: "oat milk", count: 3 });
  });
});

/**
 * A refusal is answered **and** recorded — #469.
 *
 * This branch logged nothing, on the reasoning that a known error is one the caller can act on. True
 * for the caller; the operator is a different person. A workspace whose provider rejected every
 * request got a perfectly good 422 message in the browser and left **zero lines** across all four
 * containers — which is why "compose cannot generate" took a reproduction to diagnose rather than a
 * `docker logs`.
 */
describe("a refusal reaches the log as well as the caller", () => {
  const descriptor = { name: "generate_content", effect: "read" };

  it("warns, naming the tool, the workspace and the provider's own sentence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const thrown = Object.assign(new Error("'messages' must contain the word 'json' in some form"), {
      code: "invalid_request",
    });
    const { registry: r } = registry(descriptor, undefined, thrown);

    const outcome = await executeToolCall({ registry: r, context, name: "generate_content", body: { brief: "x" } });

    expect(outcome.status).toBe(422);
    const said = warn.mock.calls.flat().join(" ");
    expect(said, "a refusal left no trace for whoever runs the deployment").toMatch(/generate_content refused/);
    expect(said).toMatch(/t1/);
    expect(said, "the provider's own sentence is the whole diagnosis").toMatch(/must contain the word 'json'/);
    warn.mockRestore();
  });

  it("records a tool that returns ok: false, not only one that throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { registry: r } = registry(descriptor, { ok: false, error: "no account is connected" });

    const outcome = await executeToolCall({ registry: r, context, name: "generate_content", body: {} });

    expect(outcome.status).toBe(422);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/generate_content declined.*no account is connected/);
    warn.mockRestore();
  });

  it("never writes the tool's arguments, which carry captions and briefs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { registry: r } = registry(descriptor, { ok: false, error: "nope" });
    await executeToolCall({ registry: r, context, name: "generate_content", body: { brief: "SECRET-CUSTOMER-BRIEF" } });
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/SECRET-CUSTOMER-BRIEF/);
    warn.mockRestore();
  });
});
