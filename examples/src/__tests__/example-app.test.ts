import { describe, expect, it } from "vitest";
import { DevAuthNotEnabled, createDevAuthenticate, PRINCIPAL_HEADER, ROLES_HEADER, TENANT_HEADER } from "../auth.js";
import { ModelNotConfigured, resolveExampleModel, definitionFor, DEFAULT_MODEL_ID } from "../model.js";
import { MAX_MEMORY_ENTRIES, NoteNotFound, createExampleStore, createExampleTools } from "../tools.js";
import { exampleAgentManifest, exampleContextProviders } from "../agent.js";
import { questionSpecsFrom } from "../questions.js";
import { buildWorkerContext } from "../worker-context.js";
import { ASSIGNED_SKILLS, EXAMPLE_SKILLS, renderSkillCatalogue } from "../skills.js";
import { SKILL_LIMITS } from "@agentkit/backend";
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
    expect(() => createDevAuthenticate({ AGENTKIT_EXAMPLE_DEV_AUTH: "true" })).toThrow(DevAuthNotEnabled);
    expect(() => createDevAuthenticate({ AGENTKIT_EXAMPLE_DEV_AUTH: "1" })).not.toThrow();
  });

  it("rejects a request with no tenant or no principal", async () => {
    const authenticate = createDevAuthenticate({ AGENTKIT_EXAMPLE_DEV_AUTH: "1" });
    // No fallback tenant. A default would mean an unauthenticated request landing in *somebody's* data, which is
    // the one failure tenant isolation exists to prevent.
    expect(await authenticate(request())).toBeNull();
    expect(await authenticate(request({ [TENANT_HEADER]: "t1" }))).toBeNull();
    expect(await authenticate(request({ [PRINCIPAL_HEADER]: "p1" }))).toBeNull();
    expect(await authenticate(request({ [TENANT_HEADER]: "  ", [PRINCIPAL_HEADER]: "p1" }))).toBeNull();
  });

  it("builds a context through the platform's own validator", async () => {
    const authenticate = createDevAuthenticate({ AGENTKIT_EXAMPLE_DEV_AUTH: "1" });
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
    const resolved = resolveExampleModel({ AGENTKIT_MODEL_API_KEY: "sk-test" });
    expect(resolved.modelId).toBe(DEFAULT_MODEL_ID);
    expect(resolved.endpoint).toBe("https://api.openai.com/v1");
  });

  it("switches to the openai-compatible provider when a base URL is given", () => {
    const resolved = resolveExampleModel({
      AGENTKIT_MODEL_API_KEY: "sk-test",
      AGENTKIT_MODEL_BASE_URL: "http://127.0.0.1:8888/v1",
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
