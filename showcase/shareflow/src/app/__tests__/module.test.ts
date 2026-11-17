/**
 * The deployable module's wiring — REQ-041 (#190).
 *
 * The thing worth testing here is not that it builds. It is that **each dependency either works or refuses by
 * name**, because the first version of this module passed `undefined as never` for four of them: it
 * typechecked, and it would have produced a container that booted, reported healthy, and failed on the first
 * turn touching a connector, the web or the model.
 *
 * So every assertion below is about a failure being *legible*. Two of the four degrade rather than refuse, and
 * that distinction is the interesting part.
 */
import { describe, expect, it, vi } from "vitest";

import {
  connectionSetupFrom,
  createAuthenticator,
  promptOrMessages,
  structuredGenerateFrom,
  webToolkitFrom,
} from "../module.js";

const request = (headers: Record<string, string>) => new Request("https://x.test/api/message", { headers });

describe("authenticate", () => {
  const auth = createAuthenticator({ SHARED_API_SECRET: "s3cret" });

  /**
   * The header names are the web app's `serviceHeaders()`, not this package's invention.
   *
   * They were `x-chorus-workspace-id` / `x-chorus-user-id` here and in the source, and those strings
   * appear nowhere in the web app or the Python backend — so every real turn would have returned 401
   * while this file passed. A test that agrees with the source about a name neither side of the wire
   * uses is the strongest possible form of passing for the wrong reason.
   */
  it("refuses when the secret is unset, rather than falling back", () => {
    /**
     * The failure this cannot be allowed to have. `requireInternalSecret` on the web side makes the same
     * choice and says why: an unset secret must mean *deny*, never "use the well-known default", because a
     * backend that served an open API to whoever forgot to configure it is unrecoverable.
     */
    // Every OTHER header is present and valid, so the secret guard is the only thing that can produce the
    // refusal. Without the tenant and principal here, this test passed with the guard deleted — the null came
    // from the missing headers, and the assertion proved nothing about the secret.
    const identified = { "x-workspace-id": "w", "x-user-id": "u" };
    const unset = createAuthenticator({});
    expect(unset(request({ ...identified, "x-api-secret": "anything" }))).toBeNull();
    // The empty-string header is the case a `secret ?? ""` fallback would actually admit.
    expect(unset(request({ ...identified, "x-api-secret": "" }))).toBeNull();
    expect(unset(request(identified))).toBeNull();
    const blank = createAuthenticator({ SHARED_API_SECRET: "" });
    expect(blank(request({ ...identified, "x-api-secret": "" }))).toBeNull();
  });

  it("refuses a wrong secret and accepts the right one", () => {
    expect(auth(request({ "x-api-secret": "wrong", "x-workspace-id": "w", "x-user-id": "u", "x-roles": "editor" }))).toBeNull();
    const ok = auth(request({ "x-api-secret": "s3cret", "x-workspace-id": "w", "x-user-id": "u", "x-roles": "editor" }));
    expect(ok?.tenantId).toBe("w");
    expect(ok?.principalId).toBe("u");
  });

  it("requires a tenant, a principal and a role, never defaulting any of them", () => {
    /**
     * All three, not any two. A tenant with no principal cannot be authorised against, a principal with
     * no tenant cannot be scoped, and a caller with no role cannot be authorised at all — and
     * defaulting any of them is how a request ends up acting as somebody, or something, else.
     *
     * The role case is #406, and it is the one that had a default. This read
     * `roleIds: (headers.get("x-roles") ?? "editor")` while the web proxy sent no such header, so
     * **every assistant turn ran as an editor whatever the caller was** — a VIEWER could ask the
     * assistant to publish and it would. The two cases below with a tenant and a principal but no
     * usable role are the exact request the proxy used to send.
     */
    const cases: Record<string, string>[] = [
      { "x-api-secret": "s3cret", "x-workspace-id": "w", "x-roles": "editor" },
      { "x-api-secret": "s3cret", "x-user-id": "u", "x-roles": "editor" },
      { "x-api-secret": "s3cret", "x-workspace-id": "", "x-user-id": "u", "x-roles": "editor" },
      { "x-api-secret": "s3cret", "x-workspace-id": "w", "x-user-id": "u" },
      { "x-api-secret": "s3cret", "x-workspace-id": "w", "x-user-id": "u", "x-roles": "" },
      { "x-api-secret": "s3cret", "x-workspace-id": "w", "x-user-id": "u", "x-roles": " , " },
    ];
    for (const headers of cases) {
      expect(auth(request(headers)), JSON.stringify(headers)).toBeNull();
    }
  });
});

describe("the connection setup", () => {
  /**
   * Called the way the adapter calls it. `createPostgresConnectorService` does `deps.setup(context)`, and the
   * first version of this wiring returned a plain object cast through `as unknown as ConnectorDeps["setup"]`
   * — it built, and the first person to ask how to connect LinkedIn would have got
   * `deps.setup is not a function`. Every assertion below therefore goes through a real call.
   */
  const context = { tenantId: "w", principalId: "u", roleIds: ["editor"] } as unknown as Parameters<
    ReturnType<typeof connectionSetupFrom>
  >[0];
  const resolve = async (env: Record<string, string>) => await connectionSetupFrom(env)(context);

  it("refuses without an app URL, rather than naming a redirect that cannot work", () => {
    // A setup naming the wrong redirect URL sends a person to a developer console to paste a value that will
    // never match, and the failure arrives at consent with no explanation.
    expect(() => connectionSetupFrom({})).toThrow(/PUBLIC_APP_URL is required/);
  });

  it("derives the redirect from the app URL and tolerates a trailing slash", async () => {
    const a = await resolve({ PUBLIC_APP_URL: "https://app.test" });
    const b = await resolve({ PUBLIC_APP_URL: "https://app.test/" });
    /**
     * The callback is **per platform**, and this test asserted a path no route serves.
     *
     * The web app's callback is `web/src/app/api/connect/[platform]/callback/route.ts`, and
     * `[platform]/route.ts` builds the `redirect_uri` it sends to the provider as
     * `new URL(\`/api/connect/${platform}/callback\`, publicBase)`. `/api/connect/callback` matched
     * `[platform]` with the single segment `callback`, `isConnectablePlatform("callback")` was false,
     * and consent landed the browser on `/accounts?error=Unsupported%20platform:%20callback`. So the
     * value the assistant told people to paste could never work, for any platform.
     *
     * The top-level field keeps the general form; the concrete URLs are per platform below. Asserted
     * against the literal route path, because that is the only thing that makes the two packages agree
     * — a directory name in one and a string in the other, with nothing between them to check.
     */
    expect(a.redirectUrl).toBe("https://app.test/api/connect/{platform}/callback");
    expect(b.redirectUrl).toBe(a.redirectUrl);
    expect(a.credentialsPageUrl).toBe("https://app.test/settings");
  });

  /**
   * Every connectable platform is explicable — #423.
   *
   * This catalogue named **three** of eleven. `CONNECTABLE_PLATFORMS` has eleven, each with a built
   * connector, so asked how to connect Reddit or YouTube the assistant could not name the console,
   * the scopes or the credentials — it answered the one question the tool exists for with "I don't
   * know" for eight of them.
   *
   * The list is pinned rather than counted, because a count passes while naming the wrong eleven.
   */
  it("explains every platform the app has a connect route for", async () => {
    const setup = await resolve({ PUBLIC_APP_URL: "https://app.test" });
    expect(setup.platforms.map((p) => p.platformId).sort()).toEqual([
      "facebook", "instagram", "linkedin", "pinterest", "reddit", "telegram",
      "threads", "tiktok", "whatsapp", "x", "youtube",
    ]);
  });

  it("gives each one a console and at least one credential to fetch", async () => {
    const setup = await resolve({ PUBLIC_APP_URL: "https://app.test" });
    for (const p of setup.platforms) {
      expect(p.consoleUrl, `${p.platformId} has no console`).toMatch(/^https:\/\/|^https:\/\/t\.me/);
      expect(p.credentialVariables.length, `${p.platformId} names no credentials`).toBeGreaterThan(0);
      expect(p.label.trim(), `${p.platformId} has no label`).not.toBe("");
    }
  });

  it("builds each redirect from that platform's own id, not a shared path", async () => {
    const setup = await resolve({ PUBLIC_APP_URL: "https://app.test" });
    for (const p of setup.platforms) {
      for (const field of p.consoleFields) {
        expect(field.url).toBe(`https://app.test/api/connect/${p.platformId}/callback`);
      }
    }
  });

  it("offers no redirect URL for the two that are not OAuth, rather than inventing one", async () => {
    /*
     * Telegram is a bot token from a chat with @BotFather and WhatsApp is a system-user token from
     * Business Settings. Neither has a console to register a redirect with. An empty list is the
     * honest answer; a plausible-looking URL would send someone hunting for a field that is not there.
     */
    const setup = await resolve({ PUBLIC_APP_URL: "https://app.test" });
    const byId = new Map(setup.platforms.map((p) => [p.platformId, p]));
    for (const id of ["telegram", "whatsapp"]) {
      expect(byId.get(id)!.consoleFields).toEqual([]);
      expect(byId.get(id)!.scopes).toEqual([]);
    }
    // And the OAuth ones do carry both, so the assertion above is a distinction and not a default.
    expect(byId.get("reddit")!.consoleFields.length).toBeGreaterThan(0);
    expect(byId.get("reddit")!.scopes.length).toBeGreaterThan(0);
  });

  it("warns when the app URL is plain http, because every platform refuses that redirect", async () => {
    /**
     * The `warning` field exists for exactly this, and it is the kind of failure that otherwise costs an hour:
     * consent refuses the redirect and says nothing useful. Localhost is exempt because the platforms exempt
     * it, so a developer running locally must not be told their setup is broken when it is not.
     */
    expect((await resolve({ PUBLIC_APP_URL: "http://staging.test" })).warning).toMatch(/plain http/);
    expect((await resolve({ PUBLIC_APP_URL: "http://localhost:3000" })).warning).toBeUndefined();
    expect((await resolve({ PUBLIC_APP_URL: "http://127.0.0.1:3000" })).warning).toBeUndefined();
    expect((await resolve({ PUBLIC_APP_URL: "https://app.test" })).warning).toBeUndefined();
    // Not fooled by a host that merely begins with the localhost name.
    expect((await resolve({ PUBLIC_APP_URL: "http://localhost.evil.test" })).warning).toMatch(/plain http/);
  });

  it("gives every platform the console URL that platform's own callback route serves", async () => {
    /**
     * This asserted that every platform's console field equalled one shared `redirectUrl` — which they
     * did, and the shared value was wrong for all of them. A consistency check between two things this
     * file produces cannot notice that neither matches the route; it only proved the mistake was
     * uniform. Now each field is checked against the path the web app actually routes.
     */
    const setup = await resolve({ PUBLIC_APP_URL: "https://app.test" });
    expect(setup.platforms.length).toBeGreaterThan(0);
    /*
     * Scoped to the OAuth platforms with #423.
     *
     * This required a console field from *every* platform, which held while all three were OAuth.
     * Telegram is a bot token from @BotFather and WhatsApp a system-user token from Business
     * Settings — neither has a console to register a redirect with, so requiring one of them would
     * force an invented URL into the catalogue to keep a test green. The dedicated test above
     * asserts those two carry none, so the exemption cannot quietly widen.
     */
    const oauth = setup.platforms.filter((p) => !["telegram", "whatsapp"].includes(p.platformId));
    expect(oauth.length).toBe(setup.platforms.length - 2);
    for (const platform of oauth) {
      expect(platform.consoleFields.length, platform.platformId).toBeGreaterThan(0);
      for (const field of platform.consoleFields) {
        expect(field.url, platform.platformId).toBe(
          `https://app.test/api/connect/${platform.platformId}/callback`,
        );
      }
      // And the placeholder never reaches a value someone is told to paste.
      for (const field of platform.consoleFields) expect(field.url).not.toContain("{platform}");
    }
  });

  it("carries credential variable NAMES and no values", async () => {
    /**
     * The structural half of what `assertNoSecrets` guards in the accounts tools: a setup carrying a real
     * secret would put it in a tool result, which is persisted in the run event log and readable by anyone
     * who can read the conversation, long after the check that produced it.
     */
    const setup = await resolve({
      PUBLIC_APP_URL: "https://app.test",
      LINKEDIN_CLIENT_SECRET: "WPL_AP1.must-not-appear",
      META_APP_SECRET: "also-must-not-appear",
    });
    // Serialised, since the run event log persists the tool result as JSON. Note this must be the *resolved*
    // setup: `JSON.stringify` of the setup function is `undefined`, and every `not.toContain` below would
    // have passed vacuously — a test that proves nothing while reading as though it proves everything.
    const serialised = JSON.stringify(setup);
    expect(serialised).not.toBe(undefined);
    expect(serialised).not.toContain("must-not-appear");
    // The names are there, which is what makes the setup actionable.
    expect(serialised).toContain("LINKEDIN_CLIENT_SECRET");
    expect(serialised).toContain("META_APP_SECRET");
  });
});

describe("the web toolkit", () => {
  it("degrades to a reasoned refusal when the provider is unusable, never an empty result", async () => {
    /**
     * **The distinction the ResearchService port exists for.** The old runtime's `websearch.py` is
     * *"deliberately fail-soft: network errors, timeouts, or a missing package yield an empty result list"* —
     * and an empty list is indistinguishable from "nothing out there", which invites a model to answer from
     * what it already believes. `not-configured` is a different sentence to a user, and a usable one.
     *
     * An unusable *name* rather than an empty environment, because an empty environment now means
     * DuckDuckGo — see the next assertion. A name nothing implements exercises the same refusal and
     * touches no network, which a unit test must not.
     */
    const { search } = await webToolkitFrom({ RETINUE_SEARCH_PROVIDER: "not-a-provider" });
    const outcome = await search("anything");
    expect(outcome.searched).toBe(false);
    if (!outcome.searched) expect(outcome.reason).toBe("not-configured");
  });

  it("has a search provider with nothing configured at all", async () => {
    /**
     * The default is the keyless one. `search_web` spent the whole cutover registered and refusing every
     * call — the toolkit needed a key *and* an endpoint, compose passed the key and a
     * `RETINUE_SEARCH_PROVIDER` nothing read, and never passed the endpoint — so "search is not
     * working" was three unset variables wearing a tool's name.
     *
     * Asserted on the *provider*, not by searching: this runs in CI and DuckDuckGo is a real endpoint.
     */
    const { searchProviderFrom } = await import("../../adapters/web/search-providers.js");
    const choice = searchProviderFrom({});
    expect(choice.ok).toBe(true);
    if (choice.ok) {
      expect(choice.name).toBe("duckduckgo");
      // Keyless: nothing to leak into a header, and nothing to forget to set.
      expect(JSON.stringify(choice.provider.headers ?? {})).not.toMatch(/key|token|bearer/i);
    }
  });

  it("provides the platform's fetcher, carrying its egress policy — not merely something callable", async () => {
    /**
     * `typeof fetchPage === "function"` was the original assertion here, and a stub returning `{ok:false}`
     * satisfied it: sabotage replacing the real fetcher with `async () => ({ok:false})` went uncaught. So the
     * assertion is now about a *policy the platform owns* — `validateHttpEgress` refuses the link-local
     * metadata address before any packet is sent, which is why this test needs no network and why a hand-rolled
     * fetcher here would not pass it.
     */
    const { fetchPage } = await webToolkitFrom({});
    // `https`, deliberately. Over `http` this URL is refused for its *scheme* before the address is ever
    // considered, so an http:// assertion here would have passed under a policy that permits private networks
    // — proving the weaker of the two guarantees while the comment claimed the stronger one.
    const blocked = await fetchPage("https://169.254.169.254/latest/meta-data/");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/private\/loopback/);

    // And the scheme half, named separately rather than conflated with the address half.
    const wrongScheme = await fetchPage("file:///etc/passwd");
    expect(wrongScheme.ok).toBe(false);
    if (!wrongScheme.ok) expect(wrongScheme.reason).toMatch(/scheme "file" is not permitted/);
  });
});

describe("prompt or messages, never both", () => {
  /**
   * WHY THIS EXISTS: the `ai` SDK rejects a call carrying both `prompt` and `messages`, and the
   * deployment's generate has no test — it needs a real provider. So the *choice* is extracted and
   * tested here, and a mutation putting `prompt` back alongside `messages` fails a unit test instead of
   * the first vision call in production.
   */
  it("passes a plain prompt through when there is no image", () => {
    expect(promptOrMessages("write a caption")).toEqual({ prompt: "write a caption" });
  });

  it("builds messages and drops the prompt field when there is one", () => {
    const built = promptOrMessages("look at this", { bytes: new Uint8Array([1, 2]), mime: "image/png" });
    expect("prompt" in built, "prompt and messages together are rejected by the SDK").toBe(false);
    expect(built["messages"]).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          /**
           * A `file` part, measured rather than assumed: `{ type: "image", image: bytes }` also works
           * and logs a deprecation warning, which is exactly how a spelling survives to the release
           * that removes it.
           */
          { type: "file", data: new Uint8Array([1, 2]), mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("carries the mime the caller resolved, not a default", () => {
    // A PNG sent as `image/jpeg` is a decode error inside the provider, which reads as the model failing.
    const built = promptOrMessages("x", { bytes: new Uint8Array([1]), mime: "image/webp" });
    const content = (built["messages"] as readonly { content: readonly Record<string, unknown>[] }[])[0]?.content;
    expect(content?.[1]?.["mediaType"]).toBe("image/webp");
  });
});

describe("structured generation", () => {
  it("refuses without a model key, rather than admitting a drafting turn it cannot finish", async () => {
    await expect(structuredGenerateFrom({})).rejects.toThrow(/RETINUE_MODEL_API_KEY is required/);
    await expect(structuredGenerateFrom({ RETINUE_MODEL_API_KEY: "" })).rejects.toThrow(/required/);
  });

  it("refuses a provider the platform does not have, rather than filing the key under a dead key", async () => {
    /**
     * **The failure this check exists for is silent.** `createProviderFactory` takes
     * `Partial<Record<ModelProvider, …>>`, so `{ credentials: { openia: { apiKey } } }` is a perfectly
     * good object with a credential nothing will ever read: the factory looks configured, boot
     * succeeds, and the first drafting turn fails inside a model call with no key.
     *
     * Every name below is a plausible mistake rather than nonsense — a typo, a vendor spelling that is
     * not the platform's, and a provider that exists but under a different id.
     */
    for (const provider of ["openia", "gemini", "azure", "anthropic-claude", ""]) {
      await expect(
        structuredGenerateFrom({ RETINUE_MODEL_API_KEY: "k", RETINUE_MODEL_PROVIDER: provider }),
        provider,
      ).rejects.toThrow(/RETINUE_MODEL_PROVIDER must be one of/);
    }
  });

  it("accepts every provider the platform actually supports", async () => {
    /**
     * Read from `MODEL_PROVIDERS` rather than listed here, which is the difference between a test and a
     * second copy of the same list. A provider added to the platform is accepted by this without an
     * edit; one removed makes the validation reject it and this test says so.
     */
    const { MODEL_PROVIDERS } = await import("@retinue/agentkit/runtime");
    for (const provider of MODEL_PROVIDERS) {
      await expect(
        structuredGenerateFrom({ RETINUE_MODEL_API_KEY: "k", RETINUE_MODEL_PROVIDER: provider }),
        provider,
      ).resolves.toBeTypeOf("function");
    }
  });

  /**
   * What was actually built, not merely that something was.
   *
   * `resolves.toBeTypeOf("function")` was the only assertion here at first, and it let two mutations
   * through: filing the credential under a fixed `openai` key regardless of the configured provider,
   * and ignoring the provider when choosing a default model id. Both produce a callable generator and
   * a deployment that fails inside its first model call — the credential under a key nothing reads,
   * or `gpt-4o` requested from Google. So the factory's inputs are captured.
   */
  const built = async (
    env: Record<string, string>,
    deps?: { workspaceModel?: (context: { tenantId: string }) => Promise<unknown> },
    call: Record<string, unknown> = {},
  ) => {
    let credentials: Record<string, unknown> | undefined;
    let definition: { provider?: string; modelId?: string } | undefined;
    vi.doMock("@retinue/agentkit/providers", () => ({
      createProviderFactory: (config: { credentials?: Record<string, unknown> }) => {
        credentials = config.credentials;
        return {
          languageModel: (d: { provider?: string; modelId?: string }) => {
            definition = d;
            return {} as never;
          },
        };
      },
    }));
    vi.resetModules();
    const { structuredGenerateFrom: fresh } = await import("../module.js");
    const generate = await fresh(env, (deps ?? {}) as never);
    // The definition is only built when the generator runs, so run it. `generateObject` is reached
    // with a stub model and will reject; the capture above has already happened by then.
    await generate({
      context: { tenantId: "w", principalId: "u" } as never,
      system: "s",
      prompt: "p",
      schema: {} as never,
      ...call,
    }).catch(() => undefined);
    vi.doUnmock("@retinue/agentkit/providers");
    return { credentials, definition };
  };

  it("files the credential under the configured provider, not a fixed one", async () => {
    const google = await built({ RETINUE_MODEL_API_KEY: "k", RETINUE_MODEL_PROVIDER: "google" });
    expect(Object.keys(google.credentials ?? {})).toEqual(["google"]);
    expect((google.credentials as { google: { apiKey: string } }).google.apiKey).toBe("k");

    const anthropic = await built({ RETINUE_MODEL_API_KEY: "k2", RETINUE_MODEL_PROVIDER: "anthropic" });
    expect(Object.keys(anthropic.credentials ?? {})).toEqual(["anthropic"]);
  });

  // #657: thread summaries run on a small model on the deployment's key; a workspace's own key keeps its model.
  it("uses a requested model on the deployment's key, and ignores it on a workspace's own key", async () => {
    const small = await built({ RETINUE_MODEL_API_KEY: "k", RETINUE_MODEL_PROVIDER: "google" }, undefined, { modelId: "gemini-2.5-flash-lite" });
    expect(small.definition).toMatchObject({ provider: "google", modelId: "gemini-2.5-flash-lite" });
    const byo = await built(
      { RETINUE_MODEL_API_KEY: "k", RETINUE_MODEL_PROVIDER: "google" },
      { workspaceModel: async () => ({ provider: "anthropic", modelId: "claude-sonnet-4-5", apiKey: "theirs" }) },
      { modelId: "gemini-2.5-flash-lite" },
    );
    expect(byo.definition).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  it("defaults the model id per provider, since gpt-4o is not a model the others have", async () => {
    // Only so the common cases need no extra variable. A deployment naming its own model still wins.
    const google = await built({ RETINUE_MODEL_API_KEY: "k", RETINUE_MODEL_PROVIDER: "google" });
    expect(google.definition?.provider).toBe("google");
    expect(google.definition?.modelId).toMatch(/^gemini-/);

    const named = await built({
      RETINUE_MODEL_API_KEY: "k",
      RETINUE_MODEL_PROVIDER: "google",
      RETINUE_MODEL_ID: "gemini-2.5-pro",
    });
    expect(named.definition?.modelId).toBe("gemini-2.5-pro");

    const openai = await built({ RETINUE_MODEL_API_KEY: "k" });
    expect(openai.definition?.provider).toBe("openai");
    expect(openai.definition?.modelId).toBe("gpt-4o");
  });

  /**
   * The BYO wire — #462, and the assertion the feature did not have for a year.
   *
   * `StructuredGenerate` has always required a `context`, documented as being there because *"it needs
   * a context to resolve the model, its credentials and its cost ceiling"*. It was accepted and thrown
   * away: every call built the same env-derived model no matter whose workspace was generating, while
   * Settings -> AI providers stored the workspace's key, the audit row recorded that provider as
   * having run, and the route billed zero credits because a BYO row existed.
   *
   * So these assert on the **credential and the model id that reach the provider factory**, which is
   * the only place the difference is observable. A test that asserted the resolver was merely *called*
   * would pass against a generator that called it and ignored the answer — which is exactly the shape
   * of the bug.
   */
  const CLAUDE = { provider: "anthropic", modelId: "claude-sonnet-5", apiKey: "sk-ant-workspace", baseUrl: undefined };

  it("generates with the workspace's own provider and key, not the deployment's", async () => {
    const out = await built(
      { RETINUE_MODEL_API_KEY: "platform-key", RETINUE_MODEL_PROVIDER: "google" },
      { workspaceModel: async () => CLAUDE },
    );
    expect(Object.keys(out.credentials ?? {})).toEqual(["anthropic"]);
    expect((out.credentials as { anthropic: { apiKey: string } }).anthropic.apiKey).toBe("sk-ant-workspace");
    expect(out.definition?.provider).toBe("anthropic");
    expect(out.definition?.modelId).toBe("claude-sonnet-5");
  });

  it("hands the resolver the calling workspace, so one tenant cannot be served another's key", async () => {
    let seen: string | undefined;
    await built(
      { RETINUE_MODEL_API_KEY: "platform-key" },
      {
        workspaceModel: async (context) => {
          seen = context.tenantId;
          return CLAUDE;
        },
      },
    );
    // "w" is the tenant the harness generates as. A resolver called with anything else — or with a
    // value captured at construction — would serve every workspace the first one's provider.
    expect(seen).toBe("w");
  });

  it("falls back to the deployment's model when the workspace has no provider of its own", async () => {
    const out = await built(
      { RETINUE_MODEL_API_KEY: "platform-key", RETINUE_MODEL_PROVIDER: "google" },
      { workspaceModel: async () => undefined },
    );
    expect(Object.keys(out.credentials ?? {})).toEqual(["google"]);
    expect((out.credentials as { google: { apiKey: string } }).google.apiKey).toBe("platform-key");
  });

  it("falls back rather than failing the generation when the resolver throws", async () => {
    /**
     * A BYO lookup is a database read, and a database read can fail. Taking generation down for every
     * workspace because one optional table could not be queried would be a worse outcome than the bug
     * this feature fixes.
     */
    const out = await built(
      { RETINUE_MODEL_API_KEY: "platform-key", RETINUE_MODEL_PROVIDER: "google" },
      {
        workspaceModel: async () => {
          throw new Error("connection terminated");
        },
      },
    );
    expect(Object.keys(out.credentials ?? {})).toEqual(["google"]);
  });

  it("carries a self-hosted endpoint's base URL, which is the only thing that makes it reachable", async () => {
    const out = await built(
      { RETINUE_MODEL_API_KEY: "platform-key" },
      {
        workspaceModel: async () => ({
          provider: "openai-compatible",
          modelId: "llama3.1",
          apiKey: undefined,
          baseUrl: "https://llm.internal/v1",
        }),
      },
    );
    const creds = out.credentials as { "openai-compatible": { baseURL?: string; apiKey?: string } };
    expect(creds["openai-compatible"].baseURL).toBe("https://llm.internal/v1");
    // No key, and no empty-string key either: the SDK falls back to its env default when `apiKey` is
    // absent, and an `apiKey: ""` would instead send an empty credential.
    expect("apiKey" in creds["openai-compatible"]).toBe(false);
  });

  it("never serves one workspace another workspace's key, in a worker that handles both", async () => {
    /**
     * The most serious failure this code could have, and the one a per-call lookup does not by itself
     * prevent: a worker process generates for every workspace on the deployment, so the *provider
     * client* is the shared thing. Memoising it by tenant, or building it once outside the call, hands
     * workspace B a client holding workspace A's credential — a cross-tenant key leak that no
     * single-workspace test can see, because every such test passes.
     *
     * So this drives **one** generator with **two** tenants and asserts each model call carried its own
     * key. The memo is keyed on the credential itself, which is also what makes a rotated key take
     * effect immediately rather than at the next restart.
     */
    const credentials: Array<Record<string, { apiKey?: string }>> = [];
    vi.doMock("@retinue/agentkit/providers", () => ({
      createProviderFactory: (config: { credentials?: Record<string, { apiKey?: string }> }) => {
        credentials.push(config.credentials ?? {});
        return { languageModel: () => ({}) as never };
      },
    }));
    vi.resetModules();
    const { structuredGenerateFrom: fresh } = await import("../module.js");

    const keys: Record<string, string> = { "tenant-a": "sk-ant-AAA", "tenant-b": "sk-ant-BBB" };
    const generate = await fresh({ RETINUE_MODEL_API_KEY: "platform-key" }, {
      workspaceModel: async (context: { tenantId: string }) => ({
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        apiKey: keys[context.tenantId],
        baseUrl: undefined,
      }),
    } as never);

    for (const tenantId of ["tenant-a", "tenant-b"]) {
      await generate({
        context: { tenantId, principalId: "u" } as never,
        system: "s",
        prompt: "p",
        schema: {} as never,
      }).catch(() => undefined);
    }
    vi.doUnmock("@retinue/agentkit/providers");

    const anthropicKeys = credentials.map((c) => c["anthropic"]?.apiKey).filter((k) => k !== undefined);
    expect(anthropicKeys).toContain("sk-ant-AAA");
    expect(anthropicKeys, "the second workspace was served the first workspace's key").toContain("sk-ant-BBB");
  });
});

describe("the header names, against the web app's own convention", () => {
  /**
   * **The test that would have caught the 401.** The authenticator read `x-chorus-workspace-id` and
   * `x-chorus-user-id`, which exist in neither the web app nor the Python backend, and every test here
   * agreed with it — because they were written from the same wrong assumption.
   *
   * So this asserts against the *other side of the wire* rather than against a name I chose. The
   * convention is `serviceHeaders()` in `web/src/lib/assistant/client.ts`, which the Python backend
   * documents reading: "Workspace scoping here relies solely on the trusted X-Workspace-Id header …
   * the shared X-API-Secret from the authenticated, secret-gated Next.js web".
   *
   * Header lookup is case-insensitive per the Fetch spec, so the capitalisation the app sends and the
   * lowercase this reads are the same header. That is asserted too, since it is the reason one spelling
   * is enough.
   */
  const auth = createAuthenticator({ SHARED_API_SECRET: "s3cret" });

  /**
   * Exactly what the web app's header builders produce, capitalisation included.
   *
   * `x-roles` is the fourth, added in #406 — and updating this fixture is the whole reason that test
   * exists. Making the backend *require* a role broke this immediately, which is what caught that the
   * web app has **three** header builders, not one: `agentkitHeaders` in `agentkitProxy.ts` for the
   * chat proxy, and `identity()` plus the events block in `agentkitClient.ts` for auto-reply drafting,
   * tool calls, campaign planning and generation. Only the first had been updated. Shipping that would
   * have refused every call from the other four features.
   *
   * That is the same shape as the 401 this suite was written for — a name that existed on one side of
   * the wire — and the same reason it asserts against the other side rather than against a value
   * chosen here.
   */
  const serviceHeaders = (workspaceId: string, userId: string): Record<string, string> => ({
    "X-API-Secret": "s3cret",
    "X-Workspace-Id": workspaceId,
    "X-User-Id": userId,
    "x-roles": "editor",
  });

  it("accepts the headers the web app actually sends", () => {
    const caller = auth(request(serviceHeaders("ws-1", "user-1")));
    expect(caller, "these are the headers every existing internal call already carries").not.toBeNull();
    expect(caller?.tenantId).toBe("ws-1");
    expect(caller?.principalId).toBe("user-1");
  });

  it("refuses the names that were invented for it", () => {
    /**
     * Kept as an assertion rather than deleted, so re-introducing them fails rather than quietly
     * working alongside the real ones. Two spellings for one thing is a second thing to keep in step.
     */
    expect(
      auth(request({ "x-api-secret": "s3cret", "x-chorus-workspace-id": "ws-1", "x-chorus-user-id": "user-1" })),
    ).toBeNull();
  });

  it("takes the ids from headers only, never from a body", async () => {
    /**
     * A caller that can set the workspace in a JSON payload can set somebody else's. The secret is what
     * makes the *headers* trustworthy, and it says nothing about a body.
     */
    const withBody = new Request("https://x.test/api/message", {
      method: "POST",
      headers: { "x-api-secret": "s3cret", "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1", userId: "user-1", message: "hi" }),
    });
    expect(auth(withBody)).toBeNull();
  });
});

