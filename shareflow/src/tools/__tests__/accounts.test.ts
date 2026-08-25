/**
 * The Accounts capabilities (#117).
 *
 * AC-3 — *"no credential or token value ever appears in a result envelope"* — gets two kinds of test
 * here, because they prove different things. The **structural** ones assert the envelope's exact key set:
 * a token cannot appear because there is no field it could appear in. The **hostile** ones feed the tool
 * an adapter that puts a secret where free text is allowed, and assert it fails rather than passing it on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  asId,
  createMemoryIdempotencyStore,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@retinue/agentkit";
import {
  ACCOUNT_TOOL_FACTORIES,
  ACCOUNT_TOOL_NAMES,
  assertNoSecrets,
  checkAccountHealthTool,
  createShareFlowToolProvider,
  getConnectionSetupTool,
  listAccountsTool,
  remediationFor,
  serviceFailure,
  type ConnectedAccount,
  type ConnectionSetup,
  type ConnectorService,
  type ShareFlowServices,
  type ShareFlowToolFactory,
  type SocialAccountId,
} from "../../index.js";

const T1 = asId<TenantId>("t1");
const CONTEXT = { tenantId: T1, principalId: asId<PrincipalId>("p1") } as unknown as ExecutionContext;

const account = (over: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id: asId<SocialAccountId>("a1"),
  platformId: "linkedin",
  displayName: "Acme Corp",
  health: "active",
  ...over,
});

const setup = (over: Partial<ConnectionSetup> = {}): ConnectionSetup => ({
  redirectUrl: "https://crm.example.com/auth/apps/callback",
  credentialsPageUrl: "https://crm.example.com/settings/applications",
  platforms: [
    {
      platformId: "linkedin",
      label: "LinkedIn",
      consoleUrl: "https://www.linkedin.com/developers/apps",
      credentialVariables: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
      consoleFields: [
        { label: "Auth > Authorized redirect URLs for your app", url: "https://crm.example.com/auth/apps/callback" },
      ],
      scopes: ["openid", "profile", "w_member_social"],
      reviewNeeded: "Personal-profile posting works self-serve; company pages need Community Management API access.",
    },
  ],
  ...over,
});

type Recorder = { readonly calls: { method: string; args: unknown }[] };

const stubConnectors = (
  recorder: Recorder,
  overrides: Partial<ConnectorService> = {},
): ConnectorService => {
  const record =
    <T>(method: string, result: T) =>
    async (_c: ExecutionContext, args?: unknown) => {
      recorder.calls.push({ method, args });
      return result;
    };
  return {
    listAccounts: record("listAccounts", [account()]),
    checkHealth: record("checkHealth", [account({ health: "expired" })]),
    getConnectionSetup: record("getConnectionSetup", setup()),
    ...overrides,
  } as unknown as ConnectorService;
};

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

let recorder: Recorder;
let idempotency: IdempotencyStore;

const build = (factory: ShareFlowToolFactory, connectors?: Partial<ConnectorService>): Tool =>
  factory({
    services: { connectors: stubConnectors(recorder, connectors) } as unknown as ShareFlowServices,
    deps: { authorization: allowAll, idempotency },
  });

const run = (tool: Tool, input: unknown = {}): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: "k1" });

beforeEach(() => {
  recorder = { calls: [] };
  idempotency = createMemoryIdempotencyStore();
});

/** AC-1. */
describe("listing destinations", () => {
  it("returns each destination with its health", async () => {
    const result = await run(build(listAccountsTool));
    expect(result).toEqual({
      ok: true,
      data: {
        accounts: [
          {
            accountId: "a1",
            platformId: "linkedin",
            displayName: "Acme Corp",
            health: "active",
            remediation: { action: "none", setupGuideHelps: false },
          },
        ],
      },
    });
    expect(recorder.calls).toEqual([{ method: "listAccounts", args: undefined }]);
  });

  it("carries the credential expiry so a break can be warned about in advance", async () => {
    // A timestamp, not a credential. It is the difference between telling the user a destination will
    // stop working on Friday and telling them it stopped working on Friday.
    const result = await run(
      build(listAccountsTool, {
        listAccounts: async () => [account({ accessExpiresAt: "2026-09-01T00:00:00.000Z" })],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: { accounts: [{ accessExpiresAt: "2026-09-01T00:00:00.000Z" }] },
    });
  });
});

/** AC-2. */
describe("an unhealthy destination", () => {
  it("names the remediation, not just the fault", async () => {
    const result = await run(build(checkAccountHealthTool), { accountIds: ["a1"] });
    expect(result).toMatchObject({
      ok: true,
      data: { accounts: [{ health: "expired", remediation: { action: "reconnect" } }] },
    });
    expect(recorder.calls).toEqual([{ method: "checkHealth", args: { accountIds: ["a1"] } }]);
  });

  it("distinguishes a broken connection from a platform that was never configured", async () => {
    // Different in kind, not degree: reconnecting cannot fix a missing LINKEDIN_CLIENT_ID, and an
    // assistant that told the user to reconnect would send them round a loop that cannot terminate.
    const result = await run(
      build(listAccountsTool, { listAccounts: async () => [account({ health: "not-configured" })] }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        accounts: [{ remediation: { action: "configure-credentials", setupGuideHelps: true } }],
      },
    });
  });

  it("maps every health value, with no fallthrough", () => {
    // Total by construction, asserted so a new health value cannot silently acquire "no action needed".
    expect(remediationFor("active").action).toBe("none");
    expect(remediationFor("expired").action).toBe("reconnect");
    expect(remediationFor("revoked").action).toBe("reconnect");
    expect(remediationFor("not-configured").action).toBe("configure-credentials");
  });

  it("returns the concrete console fields the fix needs", async () => {
    const result = await run(build(getConnectionSetupTool));
    const data = (result as { data: ReturnType<typeof Object> }).data as {
      redirectUrl: string;
      platforms: { credentialVariables: string[]; consoleFields: { label: string }[]; scopes: string[] }[];
    };
    expect(data.redirectUrl).toBe("https://crm.example.com/auth/apps/callback");
    // Variable NAMES, and the console's own labels — so it is a copy and paste rather than a hunt.
    expect(data.platforms[0]?.credentialVariables).toEqual(["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"]);
    expect(data.platforms[0]?.consoleFields[0]?.label).toContain("Authorized redirect URLs");
    expect(data.platforms[0]?.scopes).toContain("w_member_social");
  });

  it("passes on a warning that makes connecting impossible", async () => {
    // Plain http outside localhost: every platform refuses the redirect URL, so no amount of
    // reconnecting will work until the deployment has a certificate.
    const result = await run(
      build(getConnectionSetupTool, {
        getConnectionSetup: async () => setup({ warning: "http://crm.internal is not https" }),
      }),
    );
    expect(result).toMatchObject({ ok: true, data: { warning: "http://crm.internal is not https" } });
  });
});

/** AC-3 — structural. */
describe("credentials cannot appear in a result", () => {
  it("returns exactly the allowlisted fields, so there is nowhere for a token to be", async () => {
    const result = await run(build(listAccountsTool));
    const entry = (result as { data: { accounts: Record<string, unknown>[] } }).data.accounts[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "accountId",
      "displayName",
      "health",
      "platformId",
      "remediation",
    ]);
  });

  it("drops healthDetail, which is where a provider error message would land", async () => {
    // The seam keeps the field for the app's own UI. It is not agent-facing: free prose from an adapter
    // is the obvious place to paste a provider response, and that is where a token ends up.
    const result = await run(
      build(listAccountsTool, {
        listAccounts: async () => [
          account({
            health: "expired",
            healthDetail: 'provider said: {"error":"invalid_token","access_token":"ya29.A0ARrdaM-secret"}',
          }),
        ],
      }),
    );
    const entry = (result as { data: { accounts: Record<string, unknown>[] } }).data.accounts[0];
    expect(entry).not.toHaveProperty("healthDetail");
    expect(JSON.stringify(result)).not.toContain("ya29");
    expect(JSON.stringify(result)).not.toContain("access_token");
  });

  it("scans every result envelope for token-shaped strings", async () => {
    // The blunt version of the AC, run over all three capabilities: serialise what each returns and
    // assert nothing token-shaped survived.
    const forbidden = [/\bBearer\s/i, /\beyJ[A-Za-z0-9_-]{10,}/, /\b(access|refresh)[-_]?token\b/i, /\bsk-[A-Za-z0-9]{16,}/];
    for (const factory of ACCOUNT_TOOL_FACTORIES) {
      const tool = build(factory);
      const result = await run(tool, tool.descriptor.name === "check_account_health" ? { accountIds: ["a1"] } : {});
      const serialised = JSON.stringify(result);
      for (const pattern of forbidden) {
        expect(serialised, `${tool.descriptor.name} / ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

/** AC-3 — hostile adapter. */
describe("a misbehaving adapter", () => {
  it("fails rather than returning a display name that looks like a secret", async () => {
    // Fails, not scrubs: a silent scrub hides the adapter bug that produced it, and a destination whose
    // name is a token is not one anyone should publish to.
    const result = await run(
      build(listAccountsTool, {
        listAccounts: async () => [account({ displayName: "Bearer ya29.A0ARrdaM_verySecretValue" })],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_error", retryable: false, details: { field: "displayName" } },
    });
    // The offending value must not be echoed back — reporting a suspected secret in an error payload
    // would put it in exactly the place this check exists to keep it out of.
    expect(JSON.stringify(result)).not.toContain("ya29");
  });

  it("catches a JWT and a long opaque run, and leaves real names alone", () => {
    expect(() => assertNoSecrets("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "displayName")).toThrow();
    expect(() => assertNoSecrets("a".repeat(48), "displayName")).toThrow();
    expect(() => assertNoSecrets("sk-abcdefghijklmnopqrstuvwx", "displayName")).toThrow();
    // Names that must survive: real Page names, punctuation, non-Latin scripts, and a long name that is
    // long because it is words.
    for (const name of [
      "Acme Corp",
      "Acme Corp — Deutschland",
      "@acme_social",
      "日本アカウント",
      "The Very Long Official Marketing Channel For Acme Incorporated Worldwide",
    ]) {
      expect(() => assertNoSecrets(name, "displayName"), name).not.toThrow();
    }
  });

  it("refuses anything in credentialVariables that is not a bare variable name", async () => {
    // The discriminating case, and the reason this field gets a shape check rather than the generic
    // secret scanner. Sabotage showed the two implementations were indistinguishable on the
    // `NAME=value` case alone — both catch it. Neither of these contains anything secret-shaped, and
    // they are the realistic adapter mistake: putting the console's *label* in the variable list, so
    // the user is told to set an environment variable that does not exist.
    for (const bad of ["META_CLIENT_ID (Settings > Basic)", "the app id from the console", "linkedin_client_id"]) {
      const result = await run(
        build(getConnectionSetupTool, {
          getConnectionSetup: async () =>
            setup({ platforms: [{ ...setup().platforms[0]!, credentialVariables: [bad] }] }),
        }),
      );
      expect(result, bad).toMatchObject({
        ok: false,
        error: { code: "provider_error", details: { field: "credentialVariables" } },
      });
    }
  });

  it("refuses a credential value in place of a variable name", async () => {
    const result = await run(
      build(getConnectionSetupTool, {
        getConnectionSetup: async () =>
          setup({
            platforms: [
              { ...setup().platforms[0]!, credentialVariables: ["LINKEDIN_CLIENT_SECRET=WPL_AP1.abcdefghijklmnopqrstuvwxyz012345"] },
            ],
          }),
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "provider_error" } });
  });
});

/** AC-4. */
describe("connecting stays a user action", () => {
  it("exposes no capability that changes a connection", async () => {
    const provider = createShareFlowToolProvider({
      services: { connectors: stubConnectors(recorder) } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency },
      factories: ACCOUNT_TOOL_FACTORIES,
    });
    const descriptors = (await provider.listTools(CONTEXT)).map((t) => t.descriptor);
    expect(descriptors.map((d) => d.name)).toEqual([...ACCOUNT_TOOL_NAMES]);
    // Every capability is a read. Nothing here mutates a connection, in either direction.
    for (const d of descriptors) expect(d.effect).toBe("read");
    for (const d of descriptors) {
      expect(d.name).not.toMatch(/connect_(test_)?account|disconnect|revoke|authorize/);
    }
  });

  it("has no dry-run channel capability", async () => {
    // The specific one worth naming: `connect_test_account` creates an active destination with a fake
    // token that "accepts posts without contacting any platform". An assistant with it has a way to
    // manufacture a destination that silently swallows posts and then report success.
    const provider = createShareFlowToolProvider({
      services: { connectors: stubConnectors(recorder) } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency },
      factories: ACCOUNT_TOOL_FACTORIES,
    });
    const names = (await provider.listTools(CONTEXT)).map((t) => t.descriptor.name);
    expect(names).not.toContain("connect_test_account");
    expect(names.some((n) => /test|dry.?run|sandbox|simulate/.test(n))).toBe(false);
  });
});

/** AC-5. */
describe("entitlement", () => {
  it("refuses before the service is called when the policy says no", async () => {
    const tool = listAccountsTool({
      services: { connectors: stubConnectors(recorder) } as unknown as ShareFlowServices,
      deps: {
        authorization: {
          async can() {
            return { allow: false, reason: "no" };
          },
        } as unknown as AuthorizationPolicy,
        idempotency,
      },
    });
    expect(await run(tool)).toMatchObject({ ok: false });
    expect(recorder.calls).toEqual([]);
  });

  it("reports another tenant's account as not found", async () => {
    const result = await run(
      build(checkAccountHealthTool, {
        checkHealth: async () => {
          throw serviceFailure("not_found", "Account not found");
        },
      }),
      { accountIds: ["someone-elses"] },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

/** AC-5, AC-6, and argument validation. */
describe("delegation and validation", () => {
  it("names the connector function every capability wraps", () => {
    expect(ACCOUNT_TOOL_FACTORIES.map((f) => build(f).descriptor).map((d) => [d.name, d.delegatesTo])).toEqual([
      ["list_accounts", "ConnectorService.listAccounts"],
      ["check_account_health", "ConnectorService.checkHealth"],
      ["get_connection_setup", "ConnectorService.getConnectionSetup"],
    ]);
  });

  it("rejects malformed arguments with no service call", async () => {
    const health = build(checkAccountHealthTool);
    for (const input of [{}, { accountIds: [] }, { accountIds: ["a1"], extra: 1 }, { accountIds: Array(21).fill("a") }]) {
      expect(await run(health, input), JSON.stringify(input).slice(0, 50)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    // The parameterless tools take no arguments — an unexpected field is a sign the model is confused
    // about the capability, and answering anyway would confirm the confusion.
    expect(await run(build(listAccountsTool), { platformId: "linkedin" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(recorder.calls).toEqual([]);
  });
});
