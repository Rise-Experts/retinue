/**
 * The system prompt cannot name a tool that does not exist — retinue REQ-041 (#190).
 *
 * **A prompt is prose, and prose compiles.** The old runtime's 5,327-character prompt named
 * `publish_now`, `create_draft`, `read_url`, `get_post` and `read_pdf`; four were renamed in this
 * package and the fifth does not exist. A verbatim transcription would have instructed the model to
 * call five tools it does not have, and nothing in a type system, a build or a suite of behavioural
 * tests would have said a word — the failure arrives as an assistant that tries `publish_now`, gets
 * "no such tool", and tells the user it cannot publish.
 *
 * So the prompt's prose is checked against the registry. This is the same defect family as a wrong
 * config key or a mistyped provider name: a string that reads correctly and resolves to nothing.
 */
import { describe, expect, it } from "vitest";

import {
  CLAUSES,
  DEFERRED_CLAUSES,
  KEPT_CLAUSES,
  MOVED_RULES,
  PLATFORM_TOOL_NAMES,
  PROMPT_SECTIONS,
  PROMPT_VERSION,
  SECTION_TITLES,
  clauseIsSupported,
  socialAssistantInstructions,
  withheldClauses,
} from "../instructions.js";
import { CAPABILITY_INVENTORY } from "../../inventory/index.js";
import { SHAREFLOW_TOOL_FACTORIES, SHAREFLOW_TOOL_NAMES } from "../../tools/index.js";
import { SOCIAL_ASSISTANT_PRELOADED_TOOLS } from "../../manifests/index.js";
import { SHAREFLOW_BUILT_IN_SKILLS } from "../../skills/index.js";

const AVAILABLE = new Set<string>([...SHAREFLOW_TOOL_NAMES, ...PLATFORM_TOOL_NAMES]);

/** Every tool's descriptor, built without services — building must not touch them. */
const DESCRIPTORS = (() => {
  const deps = { authorization: { async can() { return { allow: true }; }, authorize: () => ({ allowed: true }) } } as never;
  const explode = new Proxy(
    {},
    { get(_t, property) { throw new Error(`read services.${String(property)} while building`); } },
  ) as never;
  return SHAREFLOW_TOOL_FACTORIES.map((factory) => factory.build({ services: explode, deps }).descriptor);
})();
const descriptionOf = (name: string): string => DESCRIPTORS.find((descriptor) => descriptor.name === name)?.description ?? "";

/**
 * Tool names mentioned in a clause's text, by shape rather than by list.
 *
 * `snake_case` words of two or more parts, which is what every tool here is called. Deriving them from
 * the prose is the whole point: a `requires` array is a promise about the text, and this is what makes
 * the text answer for itself. A word like `chorus-post` or `media_urls` is not a tool, hence the
 * membership test below only *fails* on names that look like tools and are not registered — see the
 * comment on that assertion.
 */
const mentionedNames = (text: string): readonly string[] => [
  ...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []),
];

/** Argument names and wire formats that share snake_case with tools but are not tools. */
const NOT_TOOLS = new Set(["media_urls", "chorus_post", "chorus_media", "chorus_artifact", "user_behaviour"]);

/**
 * Tools the old runtime had that this one does not, named here so a deferred clause's `requires` is
 * still checkable. Taken from the inventory rather than typed twice, so "missing" has one definition.
 */
const DEFERRED_TOOLS = new Set(
  CAPABILITY_INVENTORY.filter((capability) => capability.status === "missing")
    .map((capability) => capability.oldRuntimeRef ?? "")
    .filter((ref) => ref.startsWith("tool:"))
    .map((ref) => ref.slice("tool:".length)),
);

describe("the assembled prompt", () => {
  const prompt = socialAssistantInstructions();

  it("is not empty, so the assertions below are about something", () => {
    // The guard on the guard: a filter that excluded everything would satisfy every check that follows.
    expect(prompt.length).toBeGreaterThan(1_500);
    expect(CLAUSES.length).toBeGreaterThan(8);
  });

  it("names only tools that exist", () => {
    /**
     * The assertion this file exists for. Every snake_case name in the sent prompt must be a tool the
     * registry registers, a platform tool the app wires, or an explicitly-listed non-tool.
     *
     * `read_url`, `publish_now`, `create_draft`, `get_post` and `read_pdf` all fail this — which is
     * exactly what a copy of the old prompt would have contained.
     */
    const offences = mentionedNames(prompt).filter((name) => !AVAILABLE.has(name) && !NOT_TOOLS.has(name));
    expect(offences, `the prompt tells the model to call tools that do not exist: ${offences.join(", ")}`).toEqual([]);
  });

  it("includes every clause whose tools are available", () => {
    // The other direction: a clause silently dropped because of a typo in `requires` would leave the
    // assistant unable to do something it can, and the prompt would look fine.
    expect(withheldClauses()).toEqual([]);
  });

  it("keeps each clause's `requires` honest about its own text", () => {
    /**
     * `requires` gates inclusion, so a clause that names a tool without declaring it would be sent to a
     * deployment that lacks it — the exact failure the gating exists to prevent, reintroduced one
     * unlisted name at a time.
     */
    for (const clause of CLAUSES) {
      const named = mentionedNames(clause.text).filter((name) => AVAILABLE.has(name));
      const undeclared = named.filter((name) => !clause.requires.includes(name));
      expect(undeclared, `clause "${clause.id}" names ${undeclared.join(", ")} without declaring it`).toEqual([]);
    }
  });

  it("declares only real tool names in `requires`", () => {
    /**
     * The reverse drift: a typo in `requires` gates a clause on a tool that can never be present, so
     * the clause silently never ships and the prompt is quietly missing a rule.
     *
     * This checks the *names*, not that the text mentions them — the first version demanded the latter
     * and fired on `scheduling-clock`, which requires `schedule_post` and says "When scheduling, `when`
     * must be a future ISO-8601 instant" without naming the tool. That dependency is correct and
     * topical: the clause is about scheduling and should be withheld where scheduling is not available.
     * A checker that reports a correct clause is the false alarm that gets a checker deleted.
     */
    for (const clause of [...CLAUSES, ...DEFERRED_CLAUSES]) {
      const unreal = clause.requires.filter(
        (tool) => !AVAILABLE.has(tool) && !DEFERRED_TOOLS.has(tool),
      );
      expect(unreal, `clause "${clause.id}" requires ${unreal.join(", ")}, which is not a tool name`).toEqual([]);
    }
  });
});

describe("the clauses held back", () => {
  it("are held back because their tools are genuinely absent", () => {
    /**
     * A deferred clause whose tool now exists is a capability shipped with the prompt still silent about
     * it — the assistant can generate a PDF and does not know to offer one. This is the reminder.
     */
    for (const clause of DEFERRED_CLAUSES) {
      const present = clause.requires.filter((tool) => AVAILABLE.has(tool));
      expect(
        present,
        `${clause.id} is deferred but ${present.join(", ")} now exists — move it into CLAUSES`,
      ).toEqual([]);
    }
  });

  it("name a capability the inventory agrees is not implemented", () => {
    /**
     * The two records must not drift. `DEFERRED_CLAUSES` says "the prompt is missing this because the
     * tool is"; the inventory says which capabilities are missing. If the inventory marked one
     * implemented while a clause still waited on it, one of the two would be wrong and neither would
     * say so.
     */
    for (const clause of DEFERRED_CLAUSES) {
      const entry = CAPABILITY_INVENTORY.find((capability) => capability.oldRuntimeRef === clause.capability);
      expect(entry, `${clause.id} names ${clause.capability}, which is not in the inventory at all`).toBeDefined();
      expect(entry?.status, `${clause.capability} is ${entry?.status} in the inventory but deferred here`).toBe(
        "missing",
      );
    }
  });
});

describe("a narrowed deployment", () => {
  it("gets a prompt describing the tools it actually has", () => {
    /**
     * `socialAssistantManifest` takes `categories` so an analytics-only deployment need not carry the
     * publishing tools. Its prompt must match: an assistant told to "CALL publish_post_now directly"
     * with no such tool will try, fail, and report that publishing is broken rather than absent.
     */
    const analyticsOnly = new Set(["get_post_metrics", "get_campaign_metrics", "get_attribution"]);
    const narrowed = socialAssistantInstructions(analyticsOnly);
    expect(narrowed).not.toContain("publish_post_now");
    expect(narrowed).not.toContain("create_post_draft");
    // And it still carries the clauses that need no tool at all — the injection rule most of all.
    expect(narrowed).toContain("untrusted data");
    expect(withheldClauses(analyticsOnly)).toContain("tool-discovery");
  });

  it("keeps the prompt non-empty even with no tools, since the safety clauses need none", () => {
    const bare = socialAssistantInstructions(new Set());
    expect(bare).toContain("untrusted data");
    expect(bare).toContain("Say something happened only when a tool result in this reply confirms it");
  });

  it("forbids claiming a draft, or quoting an id, that no tool call in the turn returned", () => {
    // Production, #557: a made-up but well-formed post ID, twice, with no tool call behind it.
    const prompt = socialAssistantInstructions(new Set());
    expect(prompt).toContain("only when a tool result in this reply confirms it");
    expect(prompt).toContain("Never invent facts, numbers, quotes, names, prices, links, dates, post ids");
  });
});

describe("clauseIsSupported", () => {
  /*
   * Asserted against every multi-tool clause rather than one named example.
   *
   * This used to pick `post-cards` by name, and went `undefined.requires` the moment that clause was
   * deleted — so the rule it was guarding stopped being checked because of an unrelated removal. The
   * property is true of all of them, so test all of them.
   */
  it("requires every named tool, not any of them", () => {
    const multi = CLAUSES.filter((candidate) => candidate.requires.length > 1);
    expect(multi.length, "no multi-tool clause left to check this with").toBeGreaterThan(0);

    for (const clause of multi) {
      expect(clauseIsSupported(clause, new Set(clause.requires)), clause.id).toBe(true);
      // One missing is enough to withhold it: a clause naming a tool the model cannot call is a
      // clause telling it to do something impossible.
      for (let i = 0; i < clause.requires.length; i += 1) {
        const missingOne = clause.requires.filter((_, at) => at !== i);
        expect(clauseIsSupported(clause, new Set(missingOne)), `${clause.id} without ${clause.requires[i]}`).toBe(false);
      }
    }
  });
});

/**
 * A tool the prompt names must be a tool the model can call.
 *
 * This is the gap `requires` left open. A clause's `requires` asks whether a tool is **registered**;
 * it says nothing about whether it is **declared to the model**. This deployment preloaded two tools
 * while the prompt named nine others — including *"CALL the publish_post_now or schedule_post tool
 * directly with the post ID"* — so the model did as instructed, emitted a call by name, and the AI SDK
 * dropped a call for a function it had never declared. The run completed with no text, no tool call
 * and no error: the assistant answered nothing, deterministically, for any prompt routing to one of
 * those nine.
 *
 * It survived every test because each half was correct: the tools existed and the prompt was
 * well-formed. Only the pair was wrong.
 */
describe("the prompt and the model's tool surface agree", () => {
  it("names no tool the model has not been declared", () => {
    /**
     * The prompt **and** the skills, because both are text the model is given and both name tools.
     *
     * The first version of this test scanned only the prompt. That fixed nine tools and left six
     * named in skill instructions — `validate_publish`, `convert_media`, `reply_to_comment` and three
     * others — still undeclared, so the same silent failure survived in a channel the guard could not
     * see. Every source of instruction has to be scanned, or the next one added reopens the hole.
     */
    const prompt =
      socialAssistantInstructions() +
      "\n" +
      SHAREFLOW_BUILT_IN_SKILLS.filter((skill) => skill.status === "active")
        .map((skill) => String(skill.instructions ?? ""))
        .join("\n");
    /**
     * The meta-tools are declared by `tools-for-turn.ts` rather than preloaded, so they count as
     * available. Everything else the model can call directly is in the preloaded set.
     */
    const declared = new Set<string>([...SOCIAL_ASSISTANT_PRELOADED_TOOLS, ...PLATFORM_TOOL_NAMES]);
    const named = SHAREFLOW_TOOL_NAMES.filter((name) => prompt.includes(name));
    const undeclared = named.filter((name) => !declared.has(name));

    expect(named.length, "the prompt should name the tools it tells the model to call").toBeGreaterThan(0);
    expect(
      undeclared,
      "a tool named in the prompt but not declared makes the model emit a call the SDK drops — " +
        "the run then completes with no text, no tool call and no error",
    ).toEqual([]);
  });

  it("keeps the preloaded set to what the prompt actually needs", () => {
    /**
     * The other direction, because the preloaded set is a context cost paid on every turn of every
     * run. A tool in here that the prompt never names is a schema in context for nothing — add it to
     * the prompt or let discovery find it.
     */
    /**
     * Two deliberate exceptions, and they are listed rather than excused generally: an account list
     * and a draft list start almost every task, and the model reaches for them without being told to.
     * Anything else preloaded but unnamed is a schema sitting in context for nothing.
     */
    const STARTERS = ["list_accounts", "list_post_drafts"];

    /**
     * The third exemption, and the only one that is **computed**: a gated tool must be preloaded,
     * whether or not any prose names it.
     *
     * The platform's HITL wrapper resolves a descriptor with `deps.tools.learn(ctx, [call.name])` and
     * hands the call to the raw runner when there is none. `execute_tool` is a meta-tool absent from
     * `learn`'s corpus, so a gated tool reached through discovery takes that branch: the registry's
     * gate still refuses it, but `approval_required` comes back as an ordinary result and the engine
     * throws. The user sees a failed run reading "Tool delete_post requires approval" with no card to
     * approve. So for a gated tool, "let discovery find it" is not a cheaper option — it is an action
     * nobody can authorize.
     *
     * Derived from the built descriptors rather than named here, because `approvalPolicy` is itself
     * derived from `effect`: a tool relabelled `destructive` becomes exempt automatically, and a list
     * would have gone on excusing whatever was written in it. `manifests.test.ts` asserts the
     * requirement from the other side.
     */
    const gatedDeps = { authorization: { async can() { return { allow: true }; } } } as never;
    const explode = new Proxy(
      {},
      { get(_t, property) { throw new Error(`read services.${String(property)} while building`); } },
    ) as never;
    const GATED = new Set(
      SHAREFLOW_TOOL_FACTORIES.map((factory) => factory.build({ services: explode, deps: gatedDeps }).descriptor)
        .filter((descriptor) => descriptor.approvalPolicy !== "never")
        .map((descriptor) => descriptor.name),
    );

    const prompt =
      socialAssistantInstructions() +
      "\n" +
      SHAREFLOW_BUILT_IN_SKILLS.filter((skill) => skill.status === "active")
        .map((skill) => String(skill.instructions ?? ""))
        .join("\n");
    /**
     * #714: a tool whose description now carries a rule moved out of the prompt must be preloaded — that is where
     * the rule is read — so it is justified whether or not the prompt names it.
     */
    const HOLDS_A_RULE = new Set(MOVED_RULES.flatMap((rule) => (rule.tool === undefined ? [] : [rule.tool])));
    const unusedButPreloaded = SOCIAL_ASSISTANT_PRELOADED_TOOLS.filter(
      (name) => !prompt.includes(name) && !STARTERS.includes(name) && !GATED.has(name) && !HOLDS_A_RULE.has(name),
    );
    expect(unusedButPreloaded).toEqual([]);
  });
});

/**
 * #594: the prompt is sections with headings, not one paragraph. Until then every clause was joined with
 * a space, 7,267 characters with no structure, opening with a publishing rule.
 */
describe("the prompt's structure", () => {
  it("sends one heading per section, in order, with every rule a bullet or a numbered rule", () => {
    const prompt = socialAssistantInstructions();
    const headings = [...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(PROMPT_SECTIONS.map((section) => SECTION_TITLES[section]));
    /*
     * #714 allows three more shapes: a numbered rule, an <example> block, and one plain lead-in line right under a
     * heading ("Decide the level before every action."). Anything else is a paragraph creeping back in.
     */
    let previous = "";
    let inExample = false;
    for (const line of prompt.split("\n").filter((l) => l.trim() !== "")) {
      if (line === "<example>") inExample = true;
      const shaped = line.startsWith("## ") || line.startsWith("- ") || /^\d\. /.test(line) || inExample || previous.startsWith("## ");
      expect(shaped, line).toBe(true);
      if (line === "</example>") inExample = false;
      previous = line;
    }
  });

  it("opens with the rules that always apply (#714 AC-1), then who the assistant is", () => {
    const prompt = socialAssistantInstructions();
    expect(prompt.startsWith("## Rules that always apply\nThese come first and override everything below")).toBe(true);
    expect(PROMPT_SECTIONS.slice(0, 3)).toEqual(["rules", "identity", "risk"]);
  });

  it("gives every clause a unique id and a known section", () => {
    expect(new Set(CLAUSES.map((clause) => clause.id)).size).toBe(CLAUSES.length);
    for (const clause of CLAUSES) expect(PROMPT_SECTIONS, clause.id).toContain(clause.section);
  });

  it("drops a clause whose tools are missing and keeps the rest of its section", () => {
    const bare = socialAssistantInstructions(new Set());
    expect(bare).not.toContain("find_tools");
    expect(bare).not.toContain("generate_pdf");
    expect(bare).toContain(`## ${SECTION_TITLES.working}`);
    expect(bare).toContain(`## ${SECTION_TITLES.media}`);
  });

  it("says how to write a post and how to reply, which no clause did before", () => {
    const prompt = socialAssistantInstructions();
    expect(prompt).toContain("Open with a hook");
    expect(prompt).toContain("Never invent facts");
    expect(prompt).toContain("Lead with the result");
    expect(prompt).toContain("style kit");
  });
});

/**
 * #621 (B): "make a code image of this snippet" in a chat with a draft attached the image to the draft,
 * because both clauses said to pass the draft's postDraftId. Attaching is now only on request.
 */
describe("render clauses attach only when asked", () => {
  // #714: the code-images and diagram-files clauses moved into these two descriptions.
  it("says the same in both tools' descriptions", async () => {
    const { renderCodeSnippetTool, renderDiagramTool } = await import("../../tools/media.js");
    for (const factory of [renderCodeSnippetTool, renderDiagramTool]) {
      const tool = factory.build({ services: {} as never, deps: { authorization: { authorize: () => ({ allowed: true }) } } as never });
      expect(tool.descriptor.description).toMatch(/ONLY when the person asks to put the (image|diagram) on a post or attach it/);
      expect(tool.descriptor.description).not.toMatch(/the image is attached to that draft; otherwise attach it later/);
      expect(tool.descriptor.description).toMatch(/a draft being open in the chat is not that request; otherwise leave it out and just show the image/);
    }
  });
});

/**
 * #656 — "remember this for this chat" needs no tool. Production, 2026-09-30: outside a project it produced four
 * remember_project_rule calls, all refused.
 */
describe("chat-scoped memory (#656)", () => {
  it("says a fact for this chat is kept by the conversation, and project rules only inside a project", () => {
    // #714: moved from the personal-memory clause into the tool it is about.
    const text = descriptionOf("remember_project_rule");
    expect(text).toContain("\"for this chat\" needs no tool");
    expect(text).toContain("Only inside a project");
    expect(descriptionOf("remember_about_me")).toContain("not a rule for the project (that is remember_project_rule)");
  });
});

/**
 * #714: the rewrite. Every rule of the previous prompt is still somewhere the model reads (AC-2), the prompt is
 * shorter (AC-4), and its version is recorded with each run (AC-6).
 */
describe("the #714 rewrite", () => {
  /** The previous prompt's clause ids, typed out because the clauses themselves are gone. */
  const PREVIOUS = [
    "identity", "brand-voice", "personal-memory", "earlier-results", "workspace-brand", "role", "asking", "failed-tools",
    "writing-quality", "composer-channels", "post-workflow", "media-planning", "style-kit", "code-images", "stock-media",
    "media-library", "attachments", "pdf-documents", "artifacts", "diagrams", "diagram-files", "research", "research-pdf",
    "scheduling-clock", "report-outcomes", "post-references", "media-references", "untrusted-input", "reply-style",
    "tool-discovery",
  ];
  /** Assembled length of the previous prompt (main at 9a5c, all tools available). */
  const PREVIOUS_CHARS = 14_451;

  it("accounts for every previous clause: kept as a clause, or moved into a tool or a skill", () => {
    const moved = new Set(MOVED_RULES.map((rule) => rule.clause));
    const lost = PREVIOUS.filter((id) => KEPT_CLAUSES[id] === undefined && !moved.has(id));
    expect(lost, "a clause of the previous prompt went nowhere").toEqual([]);
    const ids = new Set(CLAUSES.map((clause) => clause.id));
    for (const [old, now] of Object.entries(KEPT_CLAUSES)) {
      expect(PREVIOUS, old).toContain(old);
      expect(ids.has(now), `${old} is kept as "${now}", which is not a clause`).toBe(true);
    }
  });

  it("finds each moved rule in its tool's description or its skill's instructions", () => {
    const skills = SHAREFLOW_BUILT_IN_SKILLS.filter((skill) => skill.status === "active");
    for (const rule of MOVED_RULES) {
      expect(rule.tool === undefined, `${rule.clause}: a rule goes to a tool or a skill, not both`).toBe(rule.skill !== undefined);
      const text =
        rule.tool !== undefined
          ? descriptionOf(rule.tool)
          : String(skills.find((skill) => skill.name === rule.skill)?.instructions ?? "");
      expect(text, `${rule.clause} → ${rule.tool ?? rule.skill}: missing "${rule.says}"`).toContain(rule.says);
    }
  });

  it("puts moved rules only in preloaded tools, whose descriptions the model sees without discovery", () => {
    const hidden = MOVED_RULES.flatMap((rule) => (rule.tool === undefined || (SOCIAL_ASSISTANT_PRELOADED_TOOLS as readonly string[]).includes(rule.tool) ? [] : [rule.tool]));
    expect(hidden).toEqual([]);
  });

  it("is at least 30% shorter than the previous prompt (AC-4)", () => {
    expect(socialAssistantInstructions().length).toBeLessThanOrEqual(PREVIOUS_CHARS * 0.7);
  });

  it("adds the risk levels, privacy, content integrity and four examples", () => {
    const prompt = socialAssistantInstructions();
    for (const level of ["- Free —", "- Confirm in chat —", "- Approval card —", "- Never —"]) expect(prompt).toContain(level);
    expect(prompt).toContain("more than 10 credits");
    expect(prompt).toContain("do-not-contact list");
    expect(prompt).toContain("Never fabricate reviews, testimonials");
    expect(prompt.match(/<example>/g)).toHaveLength(4);
    expect(prompt.match(/<\/example>/g)).toHaveLength(4);
  });

  it("has a version that follows the prompt text (AC-6)", () => {
    expect(PROMPT_VERSION).toMatch(/^v2-[0-9a-f]{10}$/);
  });
});
