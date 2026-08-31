/**
 * The three toolkits are reachable from the reference app — REQ-047 (#206), task #214, AC-7.
 *
 * This is the test the "built, tested and unreachable" defect exists for. Six times in this repository something
 * has been finished, unit-tested and then wired to nothing; `tools/github`, `tools/slack` and `tools/search` each
 * have their own passing suites, and all three could still be dead code. So the assertions here go through
 * `exampleRegistry` — the app's *own* registry, built the way the app builds it — and not a fixture assembled to
 * make the test pass.
 *
 * The one place a stub is used is execution: the app takes its `fetch` from the platform, so hitting GitHub for
 * real is not an option. Discovery therefore runs through the app's registry and execution runs through
 * `exampleToolkits(env, stubFetch)` — the same function the app calls, with one extra argument.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId } from "@retinue/agentkit";
import { readFileSync } from "node:fs";
import { asId, type ExecutionContext, type RoleId } from "@retinue/agentkit";
import { exampleRegistry } from "../index.js";
import { asExampleBackend } from "../memory-composition.js";
import { createMemoryBackend } from "../memory-app.js";
import { exampleToolkits, searchProviderFrom } from "../toolkits.js";

const context: ExecutionContext = {
  tenantId: asId("t-toolkits"),
  principalId: asId("p-toolkits"),
  roleIds: [asId<RoleId>("editor")],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req-toolkits"),
  conversationId: asId<ConversationId>("c-toolkits"),
};

const backend = () => asExampleBackend(createMemoryBackend());

const namesInCatalogue = async () => {
  const catalogue = await exampleRegistry(backend()).catalog(context, { preloaded: [], categories: [], excluded: [] });
  return [...catalogue.preloaded, ...catalogue.discoverable].map((entry) => entry.name);
};

/** The app reads `process.env`, so the test sets it and puts it back. */
const configured = { GITHUB_TOKEN: "ghp-test", SLACK_BOT_TOKEN: "xoxb-test" } as const;
const original = new Map<string, string | undefined>();
const setEnv = (values: Readonly<Record<string, string | undefined>>) => {
  for (const [key, value] of Object.entries(values)) {
    if (!original.has(key)) original.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  original.clear();
});

describe("reachable from the app, not just from their own tests", () => {
  it("puts every toolkit tool in the app's real catalogue", async () => {
    setEnv(configured);
    const names = await namesInCatalogue();
    for (const name of [
      "github_search_code",
      "github_get_file",
      "github_list_issues",
      "github_create_issue",
      "github_comment",
      "github_merge_pull_request",
      "slack_list_channels",
      "slack_read_history",
      "slack_post_message",
      "slack_reply_in_thread",
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it("does not displace the app's own tools by adding providers", async () => {
    setEnv(configured);
    const names = await namesInCatalogue();
    for (const name of ["remember", "recall", "share_note", "calculate", "now"]) expect(names, name).toContain(name);
    expect(names.length).toBe(new Set(names).size);
  });

  it("contributes nothing at all when no credential is configured", async () => {
    // The other half of the reachability claim. Without this, the test above would pass just as well if the
    // toolkits were unconditionally registered — and "wiring is the toggle" would be a comment, not behaviour.
    setEnv({ GITHUB_TOKEN: undefined, SLACK_BOT_TOKEN: undefined });
    const names = await namesInCatalogue();
    expect(names.filter((name) => name.startsWith("github_") || name.startsWith("slack_"))).toEqual([]);
  });

  it("adds web_search only when a search provider is configured — the same tool either way", async () => {
    setEnv({ RETINUE_SEARCH_PROVIDER: undefined, BRAVE_API_KEY: undefined });
    expect(await namesInCatalogue()).not.toContain("web_search");

    setEnv({ RETINUE_SEARCH_PROVIDER: "brave", BRAVE_API_KEY: "brave-test" });
    expect(await namesInCatalogue()).toContain("web_search");

    // And swapping vendor changes the provider, not the tool: same name, same schema, nothing for the model to
    // learn. That is the one-contract rule, and it is why `tools-search` exports no tools of its own.
    setEnv({ RETINUE_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "tavily-test" });
    expect(await namesInCatalogue()).toContain("web_search");
    expect(searchProviderFrom(process.env)?.name).toBe("tavily");
  });

  it("ignores a named provider whose key is missing, rather than sending an empty credential", async () => {
    setEnv({ RETINUE_SEARCH_PROVIDER: "serper", SERPER_API_KEY: undefined });
    expect(searchProviderFrom(process.env)).toBeUndefined();
  });
});

describe("a toolkit write is gated by the platform, not by the toolkit", () => {
  it("refuses github_create_issue with no approval, through the app's registry", async () => {
    setEnv(configured);
    const result = await exampleRegistry(backend()).execute(context, {
      name: "github_create_issue",
      input: { owner: "Rise-Experts", repo: "retinue", title: "from a test" },
      toolCallId: "call-gate",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("approval_required");
  });

  it("refuses slack_post_message the same way, because the classification is what gates it", async () => {
    setEnv(configured);
    const result = await exampleRegistry(backend()).execute(context, {
      name: "slack_post_message",
      input: { channel: "C1", text: "from a test" },
      toolCallId: "call-gate-2",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("approval_required");
  });

  it("does not gate a read", async () => {
    setEnv(configured);
    const names = await namesInCatalogue();
    expect(names).toContain("github_list_issues");
    // Executing it would reach the network; that a read is *not* refused for approval is asserted where the
    // classification lives, in each toolkit's own suite.
  });
});

describe("a rate limit is a retryable failure, not a dead run", () => {
  const rateLimited = async () =>
    new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "1" },
    });

  it("reports github's 429 as retryable so the runtime can back off", async () => {
    const [github] = exampleToolkits({ GITHUB_TOKEN: "ghp-test" }, rateLimited as unknown as typeof fetch);
    const tool = (await github!.listTools(context)).find((t) => t.descriptor.name === "github_list_issues")!;
    const result = await tool.execute({ context, input: { owner: "o", repo: "r" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("rate_limited");
      // The property that matters: the runtime's retry decision reads this flag. `retryable: false` here is a
      // permanent failure, and a transient rate limit would end the run.
      expect(result.error.retryable).toBe(true);
    }
  });
});

describe("the toolkits are not part of the runtime", () => {
  it("keeps @retinue/agentkit's dependencies free of every toolkit", () => {
    // Test step 4. A toolkit that became a dependency of the runtime would put a vendor's API on the platform's
    // release path — the one thing the sibling-package shape exists to prevent.
    const manifest = JSON.parse(readFileSync(new URL("../../../backend/package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
    expect(declared.filter((name) => name.startsWith("@retinue/tools-"))).toEqual([]);
  });
});


/**
 * The wave-2 toolkits are reachable from the app — REQ-054/055/056 (#232, #237, #240).
 *
 * The same guard the file above exists for, applied to the five packages shipped after it was written. Four of
 * them were finished, unit-tested and wired to nothing, which is the seventh instance of this repository's most
 * repeated defect and exactly what `toolkits.ts` was created to prevent.
 *
 * The assertions go through the app's **own** registry, not a fixture, because a fixture proves the toolkit can
 * be constructed and says nothing about whether the app ever constructs it.
 */
describe("the wave-2 toolkits reach the app's registry", () => {
  const WAVE_TWO = {
    GOOGLE_ACCESS_TOKEN: "ya29.test",
    AZURE_ACCESS_TOKEN: "az.test",
    RETINUE_ENABLE_SCRAPE: "1",
    EMAIL_FROM: "alerts@example.test",
    SMTP_HOST: "smtp.example.test",
    SMTP_USERNAME: "postmaster",
    SMTP_PASSWORD: "s3cret",
  } as const;

  it("contributes google, azure, scrape and email when configured", () => {
    const ids = exampleToolkits(WAVE_TWO).map((provider) => provider.id).sort();
    expect(ids).toEqual(["azure", "email", "google", "scrape"]);
  });

  it("puts their tools in the app's own catalogue", async () => {
    setEnv(WAVE_TWO);
    const names = await namesInCatalogue();
    /**
     * One tool from each package, and a write as well as a read.
     *
     * Wiring the toolkit is only half of reachable: the example grants tools to roles by an explicit
     * allowlist, so a newly wired package contributes providers whose tools the catalogue then filters out
     * entirely. That is what this assertion caught — four packages were wired and **none** of their tools
     * appeared — and it is why the check is against the catalogue rather than against `exampleToolkits`.
     */
    for (const name of [
      "gmail_search_messages",
      "gmail_send_message",
      "calendar_find_free_time",
      "azure_list_subscriptions",
      "azure_restart_resource",
      "web_scrape",
      "email_compose_preview",
      "email_send",
    ]) {
      expect(names, `${name} is not reachable from the app`).toContain(name);
    }
  });

  it("contributes nothing when none of them is configured", () => {
    // The rule the rest of this file follows, holding for the new packages too.
    expect(exampleToolkits({}).map((provider) => provider.id)).toEqual([]);
  });

  it("refuses to send mail with no From address, rather than guessing one", () => {
    // `EMAIL_FROM` is the field SPF and DKIM align against, so a default would produce mail that silently
    // lands in spam. Absent means the toolkit is not wired at all.
    const withoutFrom = { ...WAVE_TWO, EMAIL_FROM: undefined } as Record<string, string | undefined>;
    expect(exampleToolkits(withoutFrom).map((provider) => provider.id)).not.toContain("email");
  });

  it("does not wire the browser toolkit, and that is a decision rather than an omission", () => {
    /**
     * `@retinue/tools-browser` needs a `BrowserDriver` and the package ships none on purpose — `docs/30`
     * argues that how a browser is launched and isolated is the operator's call. This asserts the absence so
     * that wiring one later is a deliberate change with a test to update, rather than something that drifts in.
     */
    const everything = { ...WAVE_TWO, RETINUE_ENABLE_BROWSER: "1" } as Record<string, string | undefined>;
    expect(exampleToolkits(everything).map((provider) => provider.id)).not.toContain("browser");
  });
});
