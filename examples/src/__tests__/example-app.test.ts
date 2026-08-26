import { describe, expect, it } from "vitest";
import { ROLE_TOOL_NAMES, exampleRegistry } from "../index.js";
import type { ExecutionContext } from "@retinue/agentkit";
import { DevAuthNotEnabled, createDevAuthenticate, PRINCIPAL_HEADER, ROLES_HEADER, TENANT_HEADER } from "../auth.js";
import { ModelNotConfigured, resolveExampleModel, definitionFor, DEFAULT_MODEL_ID } from "../model.js";
import { MAX_MEMORY_ENTRIES, NoteNotFound, createExampleStore, createExampleTools } from "../tools.js";
import { exampleAgentManifest, exampleContextProviders } from "../agent.js";
import { questionSpecsFrom } from "../questions.js";
import { buildWorkerContext } from "../worker-context.js";
import { ASSIGNED_SKILLS, EXAMPLE_SKILLS, renderSkillCatalogue } from "../skills.js";
import { SKILL_LIMITS } from "@retinue/agentkit/context";
import { classifyMcpTool, hashToolList, mcpToolName } from "@retinue/agentkit/mcp";
import { DOCS_MCP_EFFECTS, DOCS_MCP_SERVER_ID, DOCS_MCP_TOOLS, createDocsMcpProvider, docsMcpConnection } from "../mcp.js";
import { createMcpToolProvider } from "@retinue/agentkit/mcp";
import { createInProcessBus, createMemoryBackend } from "../memory-app.js";
import { STANDARD_TOOL_CATEGORIES, createStandardToolProvider } from "@retinue/agentkit/tools";
import { asExampleBackend } from "../memory-composition.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCapabilities } from "@retinue/agentkit";
import { exampleCapabilities } from "../index.js";
import { exampleProviders } from "../providers.js";
import { COMPOSER_COMMANDS, commandQueryAt, filterCommands } from "../composer/commands.js";
import { postgresBackend } from "../stores.js";
import {
  CONVERSATION_MODES,
  DEFAULT_MODE,
  EXCLUDED_EFFECTS,
  MODE_DESCRIPTIONS,
  PLAN_EXECUTION_MODE,
  PLAN_EXECUTION_PROMPT,
  isConversationMode,
} from "../modes.js";

/**
 * The example's own units — #155.
 *
 * End-to-end behaviour is verified by *running* it, which is the point of the issue. These cover what must hold
 * without a database, a queue or a model: the refusals, the effect ledger, and the section origin. A test that
 * needed the whole stack to check "does it refuse without the flag" would never be run.
 */

const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/message", { method: "POST", headers });

describe("dev auth — AC-6", () => {
  it("refuses to be constructed without the explicit opt-in", () => {
    // At construction, not per request: a misconfigured example should fail at boot with one clear message
    // rather than return 401 to every caller and leave someone guessing.
    expect(() => createDevAuthenticate({})).toThrow(DevAuthNotEnabled);
    expect(() => createDevAuthenticate({ RETINUE_EXAMPLE_DEV_AUTH: "true" })).toThrow(DevAuthNotEnabled);
    expect(() => createDevAuthenticate({ RETINUE_EXAMPLE_DEV_AUTH: "1" })).not.toThrow();
  });

  it("rejects a request with no tenant or no principal", async () => {
    const authenticate = createDevAuthenticate({ RETINUE_EXAMPLE_DEV_AUTH: "1" });
    // No fallback tenant. A default would mean an unauthenticated request landing in *somebody's* data, which is
    // the one failure tenant isolation exists to prevent.
    expect(await authenticate(request())).toBeNull();
    expect(await authenticate(request({ [TENANT_HEADER]: "t1" }))).toBeNull();
    expect(await authenticate(request({ [PRINCIPAL_HEADER]: "p1" }))).toBeNull();
    expect(await authenticate(request({ [TENANT_HEADER]: "  ", [PRINCIPAL_HEADER]: "p1" }))).toBeNull();
  });

  it("builds a context through the platform's own validator", async () => {
    const authenticate = createDevAuthenticate({ RETINUE_EXAMPLE_DEV_AUTH: "1" });
    const context = await authenticate(
      request({ [TENANT_HEADER]: "t1", [PRINCIPAL_HEADER]: "p1", [ROLES_HEADER]: "editor, viewer" }),
    );
    expect(context).toMatchObject({ tenantId: "t1", principalId: "p1" });
    expect(context?.roleIds).toEqual(["editor", "viewer"]);
  });
});

describe("model configuration", () => {
  it("refuses to resolve without a key", () => {
    // Every other option has a defensible default; this one does not. A fallback means failing on the first turn
    // with a provider error instead of saying what is missing.
    expect(() => resolveExampleModel({})).toThrow(ModelNotConfigured);
  });

  it("defaults the model id but not the key", () => {
    const resolved = resolveExampleModel({ RETINUE_MODEL_API_KEY: "sk-test" });
    expect(resolved.modelId).toBe(DEFAULT_MODEL_ID);
    expect(resolved.endpoint).toBe("https://api.openai.com/v1");
  });

  it("switches to the openai-compatible provider when a base URL is given", () => {
    const resolved = resolveExampleModel({
      RETINUE_MODEL_API_KEY: "sk-test",
      RETINUE_MODEL_BASE_URL: "http://127.0.0.1:8888/v1",
    });
    // The dedicated OpenAI provider assumes endpoints a local server may not implement, and the failure is a 404
    // on a path nobody chose.
    expect(resolved.definition.provider).toBe("openai-compatible");
    expect(resolved.endpoint).toBe("http://127.0.0.1:8888/v1");
  });

  it("prices at zero rather than inventing numbers", () => {
    const definition = definitionFor({ provider: "openai", modelId: "some-model" });
    // A usage panel showing a cost derived from invented prices is worse than one showing zero: zero is
    // obviously not a measurement, and a plausible number is not obviously wrong.
    expect(definition.pricing.inputPerMillion).toBe(0);
    expect(definition.pricing.outputPerMillion).toBe(0);
    // Except tools, which the example genuinely requires.
    expect(definition.capabilities.tools).toBe(true);
  });
});

describe("the assistant's tools", () => {
  it("does not deduplicate the effect ledger, because that is what is under test", () => {
    const store = createExampleStore();
    const tools = createExampleTools(store);
    tools.shareNote({ noteId: "n1", idempotencyKey: "k1" });
    tools.shareNote({ noteId: "n1", idempotencyKey: "k1" });
    // A ledger that refused a repeat would answer "was the effect duplicated?" on the platform's behalf, and
    // every run would pass. Same reasoning as the #144 harness.
    expect(store.ledger.performed).toHaveLength(2);
    expect(store.ledger.distinctKeys()).toBe(1);
  });

  it("refuses to share a note that does not exist", () => {
    const tools = createExampleTools(createExampleStore());
    expect(() => tools.shareNote({ noteId: "nope", idempotencyKey: "k" })).toThrow(NoteNotFound);
  });

  it("keeps one memory per principal", () => {
    const tools = createExampleTools(createExampleStore());
    tools.remember({ principalId: "a", fact: "prefers short answers" });
    tools.remember({ principalId: "b", fact: "works in Berlin" });
    // A shared memory across principals inside one tenant would be a cross-user leak of exactly the kind the
    // platform's principal scoping exists to prevent.
    expect(tools.recall({ principalId: "a" }).facts).toEqual(["prefers short answers"]);
    expect(tools.recall({ principalId: "b" }).facts).toEqual(["works in Berlin"]);
  });

  it("drops the oldest memory rather than refusing a new one", () => {
    const tools = createExampleTools(createExampleStore());
    for (let i = 0; i < MAX_MEMORY_ENTRIES + 5; i += 1) tools.remember({ principalId: "a", fact: `f${i}` });
    const facts = tools.recall({ principalId: "a" }).facts;
    // A memory that stops accepting is one that silently stops being useful, and the user has no way to know it
    // is full. Dropping the oldest is visible in the content; refusing is not visible at all.
    expect(facts).toHaveLength(MAX_MEMORY_ENTRIES);
    expect(facts[facts.length - 1]).toBe(`f${MAX_MEMORY_ENTRIES + 4}`);
  });

  it("refuses an empty fact rather than remembering nothing", () => {
    const tools = createExampleTools(createExampleStore());
    expect(() => tools.remember({ principalId: "a", fact: "   " })).toThrow(/nothing to remember/);
  });

  describe("calculate", () => {
    const calc = (expression: string) => createExampleTools(createExampleStore()).calculate({ expression }).result;

    it("respects precedence and parentheses", () => {
      // The whole reason this tool exists: a model asked for 19*37+4 in its head is often subtly wrong.
      expect(calc("19*37+4")).toBe(707);
      expect(calc("2+3*4")).toBe(14);
      expect(calc("(2+3)*4")).toBe(20);
      expect(calc("-5+2")).toBe(-3);
      expect(calc("10/4")).toBe(2.5);
    });

    it("refuses division by zero rather than answering Infinity", () => {
      // A calculator that answers `Infinity` has given a wrong answer confidently, which is worse than refusing.
      expect(() => calc("1/0")).toThrow(/division by zero/);
    });

    it("refuses anything it cannot parse, and never evaluates code", () => {
      // No `eval`: model output is untrusted input, and a calculator is exactly where someone reaches for it.
      for (const bad of ["process.exit(1)", "2+", "((1+2)", "fetch('http://x')"])
        expect(() => calc(bad), bad).toThrow();
    });
  });

  it("seeds a note whose text is an injection payload", () => {
    const store = createExampleStore();
    const all = Array.from(store.notes.values());
    // The in-package proof that #145's neutralisation runs on a real value. Removing this fixture would make the
    // envelope test vacuous — the payload has to be *in* the data for "the assistant did not comply" to mean
    // anything.
    expect(all.some((n) => n.title.includes("## System"))).toBe(true);
    expect(all.some((n) => n.body.includes("share_note"))).toBe(true);
  });
});

describe("the context provider — AC-8", () => {
  it("marks the note list as external, because titles are user-authored", async () => {
    const store = createExampleStore();
    const [provider] = exampleContextProviders(store);
    const sections = await provider!.provide({ tenantId: "t1" } as never);
    // `platform` here would put an injection payload into the system prompt as instruction. The whole reason
    // `origin` is required with no default is that this decision must be made rather than defaulted.
    expect(sections[0]?.origin).toBe("external");
  });

  it("returns nothing when there are no notes, rather than an empty section", async () => {
    const store = createExampleStore();
    store.notes.clear();
    const [provider] = exampleContextProviders(store);
    // An empty section still costs a heading and a budget slot, and reads to a model as "there are notes" with
    // none listed.
    expect(await provider!.provide({ tenantId: "t1" } as never)).toEqual([]);
  });
});

describe("the agent manifest", () => {
  it("tells the model to call the tool rather than ask permission in prose", () => {
    // A real failure, not a hypothetical: the first wording said "ask for approval through the tool and wait",
    // and the model replied "I need your approval to publish note n1. Please confirm" and never called it. The
    // run completed, no approval was raised, and the behaviour was invisible.
    expect(exampleAgentManifest.instructions).toMatch(/CALL `share_note` immediately/);
    expect(exampleAgentManifest.instructions).toMatch(/Do not ask for permission first/i);
  });

  it("does not tell the model to be terse, which is not the same as being clear", () => {
    // A bare "be concise" produced one-line answers to questions that needed explaining — and combined with a
    // remembered "prefers short answers" it got terser still. Length should follow the question, which is what
    // the instructions now say.
    expect(exampleAgentManifest.instructions).not.toMatch(/\bBe concise\b/);
    expect(exampleAgentManifest.instructions).toMatch(/Length should follow the question/);
  });

  it("bounds the step count, so a confused loop ends", () => {
    expect(exampleAgentManifest.limits?.maxSteps).toBeGreaterThan(0);
    expect(exampleAgentManifest.limits?.maxSteps).toBeLessThan(20);
  });
});

/**
 * Modes, and the plan-execution path.
 *
 * These are the rules that are wrong in a way no amount of clicking reveals quickly: an effect list that goes
 * stale, or a plan that executes with standing approval nobody granted.
 */
describe("conversation modes", () => {
  it("keeps plan mode's exclusions keyed on effect, not on tool name", () => {
    // A name list goes stale the moment a tool is added — and the new tool would be reachable in the one mode
    // where it must not be. This asserts the *shape*, because that is the property that decays silently.
    for (const excluded of Object.values(EXCLUDED_EFFECTS)) {
      for (const entry of excluded) {
        expect(["internal-write", "external-write", "destructive", "read"]).toContain(entry);
      }
    }
  });

  it("excludes every writing effect from plan mode and nothing from the others", () => {
    expect([...EXCLUDED_EFFECTS.plan].sort()).toEqual(["destructive", "external-write", "internal-write"]);
    expect(EXCLUDED_EFFECTS.ask).toEqual([]);
    expect(EXCLUDED_EFFECTS.auto).toEqual([]);
  });

  it("defaults to asking, not acting", () => {
    // The default is what most conversations run under, so it is the one place the safe choice matters most.
    expect(DEFAULT_MODE).toBe("ask");
  });

  it("describes every mode, with an instruction for the model", () => {
    for (const mode of CONVERSATION_MODES) {
      const d = MODE_DESCRIPTIONS[mode];
      expect(d.mode).toBe(mode);
      expect(d.summary.length).toBeGreaterThan(10);
      // The instruction is what the model actually reads. A mode described only to the person is a mode the
      // model does not know it is in.
      expect(d.instruction).toContain(`## Mode: ${d.label.toLowerCase()}`);
    }
  });

  it("rejects an unrecognised mode rather than coercing it", () => {
    expect(isConversationMode("plan")).toBe(true);
    expect(isConversationMode("PLAN")).toBe(false);
    expect(isConversationMode("yolo")).toBe(false);
    expect(isConversationMode(undefined)).toBe(false);
  });

  /**
   * The one that would be tempting to get wrong. Executing a plan is the person saying "do this"; it is not
   * them granting standing approval for whatever the steps turn out to involve, with arguments they have not
   * seen. So it lands in `ask` and the irreversible steps still pause one at a time.
   */
  it("executes a plan in ask mode, never auto", () => {
    expect(PLAN_EXECUTION_MODE).toBe("ask");
    expect(PLAN_EXECUTION_MODE).not.toBe("auto");
    expect(EXCLUDED_EFFECTS[PLAN_EXECUTION_MODE]).toEqual([]);
  });

  it("tells the model in plan mode that its plan will be executed literally", () => {
    // The plan is written for a moment the model cannot see: a later turn that follows it step by step. If the
    // instruction does not say so, it writes a summary of intentions instead of steps.
    expect(MODE_DESCRIPTIONS.plan.instruction).toContain("Execute plan");
    expect(PLAN_EXECUTION_PROMPT.toLowerCase()).toContain("plan");
  });
});

/**
 * Batching what `ask_user` asks.
 *
 * `PendingQuestion.questions` has always been a list, but the tool only ever created one, so a model needing
 * two answers called it twice — and the second call landed while the run was already being parked for the
 * first, leaving an orphaned pending question whose card came back after the first was answered. Watched that
 * happen in the browser, which is why these exist.
 */
describe("ask_user question batching", () => {
  it("takes a batch and keeps its order", () => {
    const specs = questionSpecsFrom({
      questions: [
        { key: "channel", question: "Which channel?", options: ["a", "b"] },
        { key: "when", question: "When?" },
      ],
    });
    expect(specs.map((q) => q.key)).toEqual(["channel", "when"]);
    expect(specs[0]?.prompt).toBe("Which channel?");
  });

  it("still accepts the single-question shape", () => {
    // A model trained on the older shape will keep sending it, and refusing would turn a working call into an
    // error it has to guess its way out of.
    const specs = questionSpecsFrom({ question: "Which one?", options: ["x"], multiple: true });
    expect(specs).toEqual([{ key: "answer", prompt: "Which one?", options: ["x"], multiple: true }]);
  });

  /**
   * Answers are filed under `key`. A duplicate would overwrite one answer with another — silently, and in a way
   * that looks like the person only answered once.
   */
  it("never lets two questions share a key", () => {
    const specs = questionSpecsFrom({
      questions: [
        { key: "same", question: "First?" },
        { key: "same", question: "Second?" },
        { question: "Third?" },
      ],
    });
    expect(new Set(specs.map((q) => q.key)).size).toBe(3);
  });

  it("drops entries with no prompt rather than asking nothing", () => {
    // An empty question renders as a blank card the person cannot answer, which parks the run for good.
    const specs = questionSpecsFrom({ questions: [{ question: "  " }, { question: "Real?" }, {}] });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.prompt).toBe("Real?");
  });

  it("returns nothing at all for an empty ask, so the caller can refuse", () => {
    expect(questionSpecsFrom({})).toEqual([]);
    expect(questionSpecsFrom({ questions: [] })).toEqual([]);
  });

  it("allows free text when there are no options, and not when there are", () => {
    const [free] = questionSpecsFrom({ question: "Why?" });
    const [closed] = questionSpecsFrom({ question: "Which?", options: ["a"] });
    // A closed short list is closed on purpose; a question with no options can only be free text.
    expect(free?.allowOther).toBe(true);
    expect(closed?.allowOther).toBeUndefined();
    expect(questionSpecsFrom({ question: "Which?", options: ["a"], allowOther: true })[0]?.allowOther).toBe(true);
  });

  it("caps a prompt rather than storing whatever the model produced", () => {
    expect(questionSpecsFrom({ question: "x".repeat(900) })[0]?.prompt).toHaveLength(500);
  });
});

/**
 * Who a background run acts as — #164.
 *
 * This is the function that decided a worker's identity, and it had `principalId: "example-worker"` and
 * `roleIds: ["editor"]` hardcoded, because `Run` carried no principal for it to use. Two real consequences: every
 * person's memories were attributed to one fabricated identity — which is the "I told it my country and it did
 * not know" bug — and a `viewer` whose run was admitted at the API boundary executed with editor rights.
 */
describe("the worker's execution context", () => {
  const run = (over: Record<string, unknown> = {}) =>
    ({
      id: "run-1",
      tenantId: "t1",
      conversationId: "c1",
      agentId: "a1",
      agentVersion: 1,
      status: "queued",
      createdAt: "2026-01-01T00:00:00.000Z",
      principalId: "azeem",
      roleIds: ["viewer"],
      ...over,
    }) as never;

  it("acts as the caller the run was admitted for", () => {
    const context = buildWorkerContext(run());
    expect(context.principalId).toBe("azeem");
    // The caller's roles, verbatim. The worker re-authorizes with this context, so a widened list here is a
    // privilege escalation that no API-side check can catch.
    expect(context.roleIds).toEqual(["viewer"]);
  });

  it("never substitutes an identity when the run has none", () => {
    // Refused, not defaulted. A run from before identity was recorded cannot be attributed, and guessing is
    // exactly what produced both bugs.
    expect(() => buildWorkerContext(run({ principalId: undefined }))).toThrow(/carries no principal/);
    expect(() => buildWorkerContext(run({ roleIds: undefined }))).toThrow(/carries no principal/);
  });

  it("keeps an empty role list empty rather than filling it in", () => {
    // A caller with no roles is a real state, and it must not become "editor" on the way through.
    expect(buildWorkerContext(run({ roleIds: [] })).roleIds).toEqual([]);
  });

  it("carries the run and conversation, so tools and memory are scoped to them", () => {
    const context = buildWorkerContext(run());
    expect(context.runId).toBe("run-1");
    expect(context.conversationId).toBe("c1");
    expect(context.tenantId).toBe("t1");
  });
});

/**
 * Skills — #171.
 *
 * The platform had the resolver, the per-run tracker, the load limits, catalog shadowing and store adapters on
 * all three backends, and nothing used any of it. These cover what must hold without a database or a model: the
 * bodies satisfy the same rules a tenant skill must, and the catalogue costs what a catalogue should.
 */
describe("skills", () => {
  it("holds every built-in to the rules a tenant skill must satisfy", () => {
    // `validateSkillInput` runs at module load, so a malformed built-in fails the import rather than a request.
    // A built-in exempt from the rules it enforces on others is how the rules stop meaning anything — #122 was
    // exactly that, `status` load-bearing for a tenant skill and inert for a built-in.
    for (const skill of EXAMPLE_SKILLS) {
      expect(skill.name).toMatch(SKILL_LIMITS.namePattern);
      expect(skill.name.length).toBeLessThanOrEqual(SKILL_LIMITS.nameMaxLength);
      expect(skill.description.length).toBeGreaterThanOrEqual(SKILL_LIMITS.descriptionMinLength);
      expect(skill.instructions.length).toBeLessThanOrEqual(SKILL_LIMITS.instructionsMaxLength);
      expect(skill.status).toBe("active");
    }
  });

  it("gives every skill a distinct name, since a name is how one is loaded", () => {
    // Two skills sharing a name means one is unreachable and which one is an accident of ordering.
    expect(new Set(EXAMPLE_SKILLS.map((s) => s.name)).size).toBe(EXAMPLE_SKILLS.length);
  });

  it("keeps the catalogue far cheaper than the bodies it describes", () => {
    /**
     * The economics, asserted rather than assumed.
     *
     * A skill is only worth the mechanism if the catalogue is cheap and the bodies are not. If they were
     * comparable, the honest thing would be to put the instructions in the prompt and delete all of this.
     */
    const catalogue = renderSkillCatalogue(EXAMPLE_SKILLS);
    const bodies = EXAMPLE_SKILLS.map((s) => s.instructions).join("\n");
    expect(catalogue.length).toBeLessThan(bodies.length / 3);
  });

  it("names every skill in the catalogue, with its version", () => {
    const catalogue = renderSkillCatalogue(EXAMPLE_SKILLS);
    for (const skill of EXAMPLE_SKILLS) {
      expect(catalogue).toContain(skill.name);
      expect(catalogue).toContain(skill.description);
    }
    // The version matters: `load_skill` pins to it, so a catalogue without one cannot be acted on.
    expect(catalogue).toContain("v1");
  });

  it("tells the model the load limit, since exceeding it is a refusal it cannot see coming", () => {
    expect(renderSkillCatalogue(EXAMPLE_SKILLS)).toContain(String(SKILL_LIMITS.maxLoadedPerRun));
  });

  it("renders nothing at all when no skill is assigned", () => {
    // An empty "## Skills you can load" heading would be an invitation to call a tool that can only fail.
    expect(renderSkillCatalogue([])).toBe("");
  });

  it("assigns every built-in, so the catalogue and the built-ins cannot drift", () => {
    expect([...ASSIGNED_SKILLS].sort()).toEqual(EXAMPLE_SKILLS.map((s) => s.name).sort());
  });

  it("writes instructions that are procedures, not facts", () => {
    // The distinction that decides whether something should be a skill at all: a fact belongs in memory or a
    // note. Checked crudely — every body has to give an instruction — because the real check is review.
    for (const skill of EXAMPLE_SKILLS) {
      expect(skill.instructions).toMatch(/^#\s/);
      expect(skill.instructions.length).toBeGreaterThan(200);
    }
  });
});

/**
 * The MCP bridge — #173.
 *
 * `createMcpToolProvider` takes a two-method `McpClient` precisely so the platform never depends on an MCP SDK,
 * and no host provided one. These cover the wiring decisions that are not obvious from the types: what the
 * administrator classification is for, and why a server's own hints cannot be trusted.
 */
describe("the MCP bridge", () => {
  it("classifies every declared docs tool as a read, by administrator decision", () => {
    // Not by trusting the server. `classifyMcpTool` returns `external-write` for anything an administrator has
    // not classified, whatever the server's annotations claim — so this list *is* the review step.
    for (const effect of Object.values(DOCS_MCP_EFFECTS)) expect(effect).toBe("read");
  });

  it("refuses to take a server's readOnlyHint as a classification", () => {
    /**
     * The security property, asserted against the platform's own classifier.
     *
     * A hostile server marking everything `readOnlyHint: true` must not import a silent side effect. Only an
     * administrator's explicit classification relaxes the default, and that default is `external-write` — which
     * requires human approval before it can run even once.
     */
    expect(classifyMcpTool({ readOnlyHint: true }).effect).toBe("external-write");
    expect(classifyMcpTool({ readOnlyHint: true }).source).toBe("default");
    expect(classifyMcpTool({}, "read").source).toBe("administrator");
  });

  it("treats a destructive hint as destructive, since that direction is safe to believe", () => {
    // A server volunteering that its tool is dangerous is the one hint worth taking at face value: believing it
    // can only tighten the classification.
    expect(classifyMcpTool({ destructiveHint: true }).effect).toBe("destructive");
  });

  it("namespaces imported tools so a server cannot shadow a first-party one", () => {
    // A remote server naming its own tool `share_note` must not become the `share_note` the agent already has.
    expect(mcpToolName(DOCS_MCP_SERVER_ID, "share_note")).toBe("mcp__agentkit-docs__share_note");
    expect(mcpToolName(DOCS_MCP_SERVER_ID, "read_document")).not.toBe("read_document");
  });

  it("grants imported tools by name, so a server adding one does not silently become callable", () => {
    /**
     * The authorization model, and the reason the role lists these individually rather than by wildcard: a tool
     * the server adds tomorrow appears in the catalogue only once a person adds it to the role. That review step
     * is what makes importing a remote server safe.
     */
    const granted = new Set(DOCS_MCP_TOOLS);
    for (const name of Object.keys(DOCS_MCP_EFFECTS)) {
      expect(granted.has(mcpToolName(DOCS_MCP_SERVER_ID, name))).toBe(true);
    }
    expect(granted.has(mcpToolName(DOCS_MCP_SERVER_ID, "delete_everything"))).toBe(false);
  });

  it("takes the tenant from the request, not from construction", async () => {
    /**
     * #178. The provider used to be built with a tenant, and the example passed a literal `"demo"` — so every
     * other tenant's connection record claimed to belong to that one. The tools still worked, because a stdio
     * client ignores the connection's tenant, which is what made it invisible: an inert mislabelling until
     * something read it, and `redactConnection`, an `McpConnectionStore` registration and an audit trail all do.
     *
     * The first version of this test asserted `snapshot().connectionId` was stable across tenants — which it
     * was, before and after, because the connection *id* never depended on the tenant. It passed against the
     * bug. The tenant has to be read off the connection record itself, which is why `connectionFor` exists.
     */
    const client = { async listTools() { return []; }, async callTool() { return {}; } };
    const provider = createDocsMcpProvider(client);
    const context = (tenantId: string) =>
      ({ tenantId, principalId: "p", roleIds: [], locale: "en", timezone: "UTC", requestId: "r" }) as never;

    expect(provider.connectionFor(context("t1")).tenantId).toBe("t1");
    expect(provider.connectionFor(context("t2")).tenantId).toBe("t2");

    // The connection id is deliberately stable across tenants — it forms the namespaced tool names, and a
    // per-tenant id would make `mcp__agentkit-docs__read_document` a different tool for each one.
    const ids = [];
    for (const tenantId of ["t1", "t2"]) ids.push((await provider.snapshot(context(tenantId))).connectionId);
    expect(ids).toEqual([DOCS_MCP_SERVER_ID, DOCS_MCP_SERVER_ID]);
  });

  it("takes its provider id from the platform rather than restating the mcp: format", () => {
    // The example builds `id` itself, so it holds a copy of a format the platform owns. Pin the copy against
    // the platform's own derivation: a change to the prefix should fail here, not namespace tools wrongly.
    const client = { async listTools() { return []; }, async callTool() { return {}; } };
    const provider = createDocsMcpProvider(client);
    const platform = createMcpToolProvider({ connection: docsMcpConnection("t1" as never), client });
    expect(provider.id).toBe(platform.id);
    expect(provider.connectionId).toBe(platform.connectionId);
  });

  it("records the connection without a credential", () => {
    // A connection record must never hold a secret — only a reference something else resolves. True here even
    // though a local process needs none, because the shape is what stops the next server leaking one.
    const connection = docsMcpConnection("t1" as never);
    expect(JSON.stringify(connection)).not.toContain("password");
    expect(connection.auth).toEqual({ kind: "none" });
    expect(connection.transport).toBe("stdio");
  });

  it("detects a tool list that changed between two snapshots", () => {
    // A remote server can change its tools between turns of one conversation. A run that approved
    // `mcp__x__publish` must not silently end up calling something else.
    const before = hashToolList([{ name: "a" }, { name: "b" }]);
    expect(hashToolList([{ name: "b" }, { name: "a" }])).toBe(before);
    expect(hashToolList([{ name: "a" }, { name: "c" }])).not.toBe(before);
  });
});

/**
 * `fetch_url` — the outbound tool, and the egress policy at the point it matters most (#176).
 *
 * Everything refused here was already refused for an MCP endpoint. The difference is that an MCP endpoint is
 * configured by an operator once, and this argument is produced fresh by a language model on every call —
 * possibly under the influence of a page it just read. So these are the tests that matter most in the example.
 */
/**
 * `fetch_url` now comes from the kit — REQ-039 (#188).
 *
 * This app used to carry its own fetcher and its own egress policy. Both are gone: `@retinue/agentkit/tools`
 * ships the tool, and the client's refusals are tested exhaustively where they live
 * (`backend/src/toolkit/__tests__/http.test.ts` — twenty-two cases including every SSRF shape).
 *
 * What is left here is the claim those tests cannot make: that this application's *own registry*, with its own
 * authorization policy and its own approval gate, actually offers the tool and actually refuses. A library tool
 * that is perfect and unreachable is the defect this repo keeps finding.
 */
describe("the kit's tools, through this app's registry", () => {
  // The real composition: `asExampleBackend` over the in-memory stores is what `memory-app` runs, so the
  // registry under test is the one the app builds and not a fixture that resembles it.
  const memoryBackend = () => asExampleBackend(createMemoryBackend());

  const context = {
    tenantId: "t1",
    principalId: "p1",
    roleIds: ["editor"],
    locale: "en",
    timezone: "UTC",
    requestId: "r1",
    conversationId: "c1",
  } as unknown as ExecutionContext;

  it("offers the library's tools alongside the app's own", async () => {
    const backend = memoryBackend();
    const catalogue = await exampleRegistry(backend).catalog(context, { preloaded: [], categories: [], excluded: [] });
    const names = [...catalogue.preloaded, ...catalogue.discoverable].map((entry) => entry.name);
    for (const name of ["fetch_url", "fetch_json", "http_request", "calculate", "now", "parse_csv", "query_json"]) {
      expect(names, name).toContain(name);
    }
    // And the app's own domain tools are still there: adding a provider must not displace one.
    for (const name of ["remember", "recall", "share_note"]) expect(names, name).toContain(name);
  });

  it("offers each name exactly once", async () => {
    // Two providers, and `findAuthorized` takes the first match — so a name in both would execute as whichever
    // was registered first, silently. The registry refuses an ambiguous name now (#188), which would show up
    // here as the name vanishing rather than as a duplicate.
    const backend = memoryBackend();
    const catalogue = await exampleRegistry(backend).catalog(context, { preloaded: [], categories: [], excluded: [] });
    const names = [...catalogue.preloaded, ...catalogue.discoverable].map((entry) => entry.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it("refuses the cloud metadata address through the real registry", async () => {
    const backend = memoryBackend();
    const result = await exampleRegistry(backend).execute(context, {
      name: "fetch_url",
      input: { url: "https://169.254.169.254/latest/meta-data/" },
      toolCallId: "call-ssrf",
    });
    // A returned refusal, not a thrown error: the model can act on "that URL is not permitted" and cannot act
    // on "something broke" except by trying again.
    expect(result.ok).toBe(true);
    expect(result.ok && (result.data as { ok: boolean; reason?: string }).ok).toBe(false);
  });

  it("calculates rather than guessing", async () => {
    const backend = memoryBackend();
    const result = await exampleRegistry(backend).execute(context, {
      name: "calculate",
      input: { expression: "(17 * 23) + sqrt(144)" },
      toolCallId: "call-calc",
    });
    expect(result.ok && (result.data as { value: number }).value).toBe(17 * 23 + 12);
  });
});

/**
 * One wiring, two adapters — #155 AC-7.
 *
 * The single-process mode exists so the example runs with nothing installed. The risk it introduces is a *second*
 * composition that drifts from the first, and drift of exactly that shape is how #157 (an unwired message store)
 * and #161 (a no-op publisher) survived: both worked in one arrangement and were broken in the other.
 *
 * So these assert the two share what they must, rather than that the memory mode "works" — which only running it
 * can show.
 */
describe("the memory composition", () => {
  it("supplies every port the app's backend bundle requires", () => {
    /**
     * The check that would have caught a real break in this refactor.
     *
     * `run-app.mjs` kept passing a `SqlExecutor` where `exampleProviders` had started expecting a backend, so
     * `principalMemory` was `undefined` and compaction failed with
     * `Cannot read properties of undefined (reading 'retrieve')`. It was *swallowed and logged*, because a failed
     * compaction should not fail a turn — so the only symptom was compaction silently never running.
     */
    const mapped = asExampleBackend(createMemoryBackend());
    for (const port of [
      "conversations",
      "messages",
      "sessions",
      "grants",
      "summaries",
      "rollups",
      "limits",
      "runs",
      "eventLog",
      "interactions",
      "idempotency",
      "principalMemory",
      "skills",
      "usage",
      "coordinator",
      "live",
    ] as const) {
      expect(mapped[port], `${port} must be supplied`).toBeDefined();
    }
  });

  it("builds the worker's coordinator lazily, so a runner-less process fails at use and says why (#178)", () => {
    // The worker is handed no `TransactionRunner` and never uses the coordinator. `postgresBackend` used to
    // build one eagerly with `runner as TransactionRunner`, so the worker held a coordinator constructed over
    // `undefined`: inert only while nothing touched it, and the eventual failure would have read
    // `Cannot read properties of undefined (reading 'transaction')` from a place that looks unrelated.
    const sql = (() => { throw new Error("no query should be issued"); }) as unknown as SqlExecutor;
    const backend = postgresBackend(sql, { subscribe: () => { throw new Error("unused"); } } as never);

    // Construction is silent — that is the point, the worker's `deps()` must not throw.
    expect(backend.coordinator).toBeDefined();
    // Use names the missing piece.
    expect(() => backend.coordinator.claimOrEnqueue).toThrow(/TransactionRunner/);
  });

  it("gives the memory composition the same context providers as the Postgres one", () => {
    // Same list, same order: the prompt is assembled from it, and a mode whose prompt differs is a mode whose
    // behaviour differs for reasons nobody chose.
    const mapped = asExampleBackend(createMemoryBackend());
    expect(exampleProviders(mapped).map((p) => p.id)).toEqual(["example.notes", "principal-memory"]);
  });

  it("returns one store instance, not a factory called twice", async () => {
    /**
     * The difference that matters between the two adapters. A Postgres factory closes over an executor and is
     * safe to call repeatedly; a memory factory *is* the state, so calling it twice gives two empty worlds — and
     * the symptom is a message that vanishes between being written and being read.
     */
    const backend = createMemoryBackend();
    const a = asExampleBackend(backend);
    const b = asExampleBackend(backend);
    expect(a.messages).toBe(b.messages);
    expect(a.principalMemory).toBe(b.principalMemory);
  });

  it("delivers a published event to a subscriber", async () => {
    // The in-process bus stands in for Redis. Its queue is the part worth testing: an event published between
    // two `next()` calls must not be dropped, which is the failure the Redis source's buffer also exists for.
    const bus = createInProcessBus();
    const iterator = bus.live.subscribe("c1")[Symbol.asyncIterator]();
    await bus.publisher.publish("c1", { type: "run.started" });
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "run.started" });
    await iterator.return?.();
  });

  it("does not deliver one channel's events to another", async () => {
    const bus = createInProcessBus();
    const other = bus.live.subscribe("c2")[Symbol.asyncIterator]();
    await bus.publisher.publish("c1", { type: "run.started" });
    // Nothing queued for c2, so a read would block — asserted by racing a resolved promise rather than waiting.
    const raced = await Promise.race([other.next(), Promise.resolve("nothing")]);
    expect(raced).toBe("nothing");
    await other.return?.();
  });
});

/**
 * The composer's rules — #179.
 *
 * The editor itself needs a DOM and is not tested here; these are the decisions that have answers, and they are
 * in a separate module for that reason.
 */
describe("the composer's command menu", () => {
  it("opens only when the slash opens the message", () => {
    expect(commandQueryAt("/comp")).toBe("comp");
    expect(commandQueryAt("/")).toBe("");
    // A slash mid-sentence is a date, a path or a fraction. A menu that appears while someone types `and/or` is
    // a menu that interrupts four times a day.
    expect(commandQueryAt("and/or")).toBeNull();
    expect(commandQueryAt("what about 3/4")).toBeNull();
    // A space ends the command: no command here takes arguments, so the menu closes rather than filtering on
    // words that are no longer part of the name.
    expect(commandQueryAt("/compact now")).toBeNull();
    expect(commandQueryAt("hello")).toBeNull();
  });

  it("ranks a name match above an alias match", () => {
    // `a` is the first letter of `auto` and `ask`, and appears in `/compact`'s `summarise`-family aliases. The
    // commands whose *names* match have to come first, or the highlighted row is one the person did not mean.
    const names = filterCommands("a").map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(["auto", "ask"]);
    expect(names).toContain("compact");
    expect(names.indexOf("compact")).toBeGreaterThan(names.indexOf("ask"));
  });

  it("finds a command by the word someone reaches for before learning yours", () => {
    // Nobody's first guess for "condense the history" is `/compact`.
    for (const q of ["summarise", "summarize", "condense", "shrink"]) {
      expect(filterCommands(q).map((c) => c.name), q).toContain("compact");
    }
  });

  it("lists everything for an empty query, in declared order", () => {
    expect(filterCommands("")).toEqual(COMPOSER_COMMANDS);
    expect(filterCommands("   ")).toEqual(COMPOSER_COMMANDS);
  });

  it("matches a summary only at a word boundary", () => {
    // `hist` starts a word in "Condense the history", so it finds `/compact`. `ist` sits mid-word, and pulling a
    // command in on a letter sequence from the middle of its prose is how a menu starts feeling random.
    expect(filterCommands("hist").map((c) => c.name)).toContain("compact");
    expect(filterCommands("ist")).toEqual([]);
  });

  it("returns nothing rather than everything when a query matches no command", () => {
    // The menu closes on an empty result. Falling back to the full list would put a highlighted `/auto` under
    // the caret of someone typing `/deploy`, one Enter away from changing the mode they did not ask about.
    expect(filterCommands("deploy")).toEqual([]);
  });

  it("names only commands the page actually implements", () => {
    /**
     * A menu listing something unimplemented is worse than no menu: the person now believes the app can do it.
     *
     * Read out of the page rather than restated here, because a list written twice is a list that will disagree.
     * `runCommand` in `public/index.html` is the implementation; the catalogue is what the menu offers, and the
     * only useful assertion is that the second is a subset of the first.
     *
     * Resolved from `import.meta.dirname`, not the working directory — a path relative to `process.cwd()` passes
     * from the package and fails from the repo root, which is a test about where it was run from.
     */
    const page = readFileSync(resolve(import.meta.dirname, "../../public/index.html"), "utf8");
    const body = page.slice(page.indexOf("const runCommand = async (name)"));
    const implementation = body.slice(0, body.indexOf("const send = async ()"));
    expect(implementation).not.toBe("");
    for (const command of COMPOSER_COMMANDS) {
      expect(implementation.includes(`"${command.name}"`), `/${command.name} must be handled`).toBe(true);
    }
  });
});

describe("the app's capability declaration", () => {
  it("matches what the app wires", () => {
    /**
     * #198. The declaration is only worth having if it is checked — `resolveCapabilities` throws when anything
     * is declared on with nothing behind it, *or* wired with nothing declaring it. Calling it here is what makes
     * the second direction bite: remove a store from the composition and this fails, naming the capability,
     * instead of the feature going quietly missing.
     */
    const capabilities = exampleCapabilities();
    expect(capabilities.history).toBe("on");
    expect(capabilities.memory).toBe("on");
    expect(capabilities.citations).toBe("on");
    // Off, and truthfully: the docs MCP server is composed per role rather than in the base runtime.
    expect(capabilities.mcp).toBe("off");
  });

  it("refuses a declaration that claims a capability the app does not wire", () => {
    // The guarantee, demonstrated rather than described: turning something on without its store is refused.
    expect(() =>
      resolveCapabilities({ profile: "assistant", capabilities: { mcp: "on" }, wired: new Set(["messages"]) }),
    ).toThrow(/mcp is on but/);
  });
});

/**
 * Grants are decided, and the decision is not allowed to go stale — REQ-039 (#188).
 *
 * The role lists name the kit's tools explicitly rather than deriving them from `STANDARD_TOOL_NAMES`, so that
 * upgrading the library cannot widen what a model may do on its own. The cost of that choice is drift: the
 * library gains a tool, this app never grants it, and the tool is simply invisible — which looks exactly like a
 * tool that is broken.
 *
 * So the drift is a failing test rather than a discovery. A new library tool has to be granted or excluded; what
 * it may not be is unnoticed.
 */
describe("every tool the app wires is a tool some role can use", () => {
  it("has no tool that is registered and grantable to nobody", async () => {
    const backend = asExampleBackend(createMemoryBackend());
    const provider = createStandardToolProvider({
      deps: { authorization: { can: async () => ({ allowed: true }) } as never, idempotency: backend.idempotency },
      http: {},
    });
    const listed = (
      await provider.listTools({
        tenantId: "t1",
        principalId: "p1",
        roleIds: ["editor"],
        locale: "en",
        timezone: "UTC",
        requestId: "r1",
        conversationId: "c1",
      } as unknown as ExecutionContext)
    ).map((tool) => tool.descriptor.name);

    // Both roles' grants, together: a tool only `editor` may use is still decided.
    const granted = new Set(ROLE_TOOL_NAMES);
    const ungranted = listed.filter((name) => !granted.has(name));
    expect(ungranted, `wired but granted to no role: ${ungranted.join(", ")}`).toEqual([]);
  });
});

/**
 * Registered is not the same as reachable — REQ-039 (#188).
 *
 * The app hands the model its **preloaded** tools only, and preloading is by *category*. So a tool can be
 * registered, authorized, and present in the catalogue while never being offered to the model — which is what
 * happened to all fifteen library tools, whose categories were not in the list. The symptom was the assistant
 * declining to fetch a URL it appeared to have a tool for: it reads as a model problem, and it is a wiring one.
 *
 * This asserts the end of the chain rather than any link in it: whatever the registry lists for this app, the
 * model is offered.
 */
describe("every registered tool is actually offered to the model", () => {
  it("strands nothing in the discoverable half", async () => {
    const backend = asExampleBackend(createMemoryBackend());
    const context = {
      tenantId: "t1",
      principalId: "p1",
      roleIds: ["editor"],
      locale: "en",
      timezone: "UTC",
      requestId: "r1",
      conversationId: "c1",
    } as unknown as ExecutionContext;

    const registry = exampleRegistry(backend);
    // The app's own preload policy, from `buildTools`. If that changes and this does not, this test is the copy
    // that goes stale — so it asserts a property of the *result*, not the policy: nothing left behind.
    const catalogue = await registry.catalog(context, {
      preloaded: [],
      categories: ["assistant", `mcp:${DOCS_MCP_SERVER_ID}`, ...STANDARD_TOOL_CATEGORIES],
      excluded: [],
    });

    const stranded = catalogue.discoverable.map((entry) => entry.name);
    expect(stranded, `registered but never offered to the model: ${stranded.join(", ")}`).toEqual([]);
    // And the preloaded ones carry schemas: a descriptor without one reaches the model as a permissive object,
    // and every call arrives as `{}` — the bug the `buildTools` comment records.
    for (const descriptor of catalogue.preloaded) {
      expect(descriptor.inputSchema, descriptor.name).toBeDefined();
    }
  });
});
