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
import { describe, expect, it } from "vitest";

import { connectionSetupFrom, createAuthenticator, structuredGenerateFrom, webToolkitFrom } from "../module.js";

const request = (headers: Record<string, string>) => new Request("https://x.test/api/message", { headers });

describe("authenticate", () => {
  const auth = createAuthenticator({ SHARED_API_SECRET: "s3cret" });

  it("refuses when the secret is unset, rather than falling back", () => {
    /**
     * The failure this cannot be allowed to have. `requireInternalSecret` on the web side makes the same
     * choice and says why: an unset secret must mean *deny*, never "use the well-known default", because a
     * backend that served an open API to whoever forgot to configure it is unrecoverable.
     */
    // Every OTHER header is present and valid, so the secret guard is the only thing that can produce the
    // refusal. Without the tenant and principal here, this test passed with the guard deleted — the null came
    // from the missing headers, and the assertion proved nothing about the secret.
    const identified = { "x-chorus-workspace-id": "w", "x-chorus-user-id": "u" };
    const unset = createAuthenticator({});
    expect(unset(request({ ...identified, "x-internal-secret": "anything" }))).toBeNull();
    // The empty-string header is the case a `secret ?? ""` fallback would actually admit.
    expect(unset(request({ ...identified, "x-internal-secret": "" }))).toBeNull();
    expect(unset(request(identified))).toBeNull();
    const blank = createAuthenticator({ SHARED_API_SECRET: "" });
    expect(blank(request({ ...identified, "x-internal-secret": "" }))).toBeNull();
  });

  it("refuses a wrong secret and accepts the right one", () => {
    expect(auth(request({ "x-internal-secret": "wrong", "x-chorus-workspace-id": "w", "x-chorus-user-id": "u" }))).toBeNull();
    const ok = auth(request({ "x-internal-secret": "s3cret", "x-chorus-workspace-id": "w", "x-chorus-user-id": "u" }));
    expect(ok?.tenantId).toBe("w");
    expect(ok?.principalId).toBe("u");
  });

  it("requires both a tenant and a principal, never defaulting either", () => {
    /**
     * Both, not either. A tenant with no principal cannot be authorised against and a principal with no
     * tenant cannot be scoped — and defaulting either is how a request ends up acting as somebody else.
     */
    const cases: Record<string, string>[] = [
      { "x-internal-secret": "s3cret", "x-chorus-workspace-id": "w" },
      { "x-internal-secret": "s3cret", "x-chorus-user-id": "u" },
      { "x-internal-secret": "s3cret", "x-chorus-workspace-id": "", "x-chorus-user-id": "u" },
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
    expect(a.redirectUrl).toBe("https://app.test/api/connect/callback");
    expect(b.redirectUrl).toBe(a.redirectUrl);
    expect(a.credentialsPageUrl).toBe("https://app.test/settings");
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

  it("names a redirect URL every platform's console field agrees on", async () => {
    // One redirect for every platform and workspace, per `ConnectionSetup`. A platform whose console field
    // named a different URL would be the one platform that silently never connects.
    const setup = await resolve({ PUBLIC_APP_URL: "https://app.test" });
    expect(setup.platforms.length).toBeGreaterThan(0);
    for (const platform of setup.platforms) {
      expect(platform.consoleFields.length, platform.platformId).toBeGreaterThan(0);
      for (const field of platform.consoleFields) expect(field.url, platform.platformId).toBe(setup.redirectUrl);
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
  it("degrades to a reasoned refusal with no search provider, never an empty result", async () => {
    /**
     * **The distinction the ResearchService port exists for.** The old runtime's `websearch.py` is
     * *"deliberately fail-soft: network errors, timeouts, or a missing package yield an empty result list"* —
     * and an empty list is indistinguishable from "nothing out there", which invites a model to answer from
     * what it already believes. `not-configured` is a different sentence to a user, and a usable one.
     */
    const { search } = await webToolkitFrom({});
    const outcome = await search("anything");
    expect(outcome.searched).toBe(false);
    if (!outcome.searched) expect(outcome.reason).toBe("not-configured");
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

describe("structured generation", () => {
  it("refuses without a model key, rather than admitting a drafting turn it cannot finish", async () => {
    await expect(structuredGenerateFrom({})).rejects.toThrow(/RETINUE_MODEL_API_KEY is required/);
    await expect(structuredGenerateFrom({ RETINUE_MODEL_API_KEY: "" })).rejects.toThrow(/required/);
  });
});
