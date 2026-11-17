import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createWorkspaceModelResolver } from "../workspace-model.js";

/**
 * The web app's encryption, re-implemented here rather than imported — #462.
 *
 * `web` and `shareflow` are separate packages with separate builds and no shared module, so the
 * decryption in `workspace-model.ts` is a **transcription** of `web/src/lib/crypto.ts`. A transcription
 * that drifts is the failure this file exists to catch, and it can only catch it if the test is an
 * independent second implementation: importing the same helper the adapter imports would agree with any
 * mistake, including one made in both places at once.
 *
 * So this is written from `web/src/lib/crypto.ts` directly — scrypt with the literal salt
 * `shareflow_salt`, AES-256-GCM, and `iv:tag:ciphertext` in hex. Change either side and these fail.
 */
const encryptAsWebDoes = (value: unknown, secret: string): string => {
  const key = scryptSync(secret, "shareflow_salt", 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${body.toString("hex")}`;
};

const SECRET = "a-real-looking-encryption-secret-0123456789";
const CONTEXT = { tenantId: "11111111-1111-1111-1111-111111111111" } as never;

/** One row, as `public.workspace_llm_configs` holds it. */
type Row = {
  provider: string;
  modality: string;
  is_active: boolean;
  model: string | null;
  api_key_encrypted: string | null;
  base_url: string | null;
};

const resolverFor = (rows: readonly Row[], env: Record<string, string | undefined> = { ENCRYPTION_SECRET: SECRET }) => {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const resolve = createWorkspaceModelResolver({
    sql: {
      query: async (sql: string, params: readonly unknown[]) => {
        queries.push({ sql, params });
        return rows;
      },
    } as never,
    env,
  });
  return { resolve, queries };
};

const claudeRow = (over: Partial<Row> = {}): Row => ({
  provider: "anthropic",
  modality: "text",
  is_active: true,
  model: "claude-sonnet-5",
  api_key_encrypted: encryptAsWebDoes({ key: "sk-ant-abc123" }, SECRET),
  base_url: null,
  ...over,
});

describe("the workspace's own model", () => {
  it("decrypts a key the web app encrypted, which is the whole contract between the two services", async () => {
    const { resolve } = resolverFor([claudeRow()]);
    await expect(resolve(CONTEXT)).resolves.toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      apiKey: "sk-ant-abc123",
      baseUrl: undefined,
    });
  });

  it("scopes the lookup to the calling workspace's active text config", async () => {
    /**
     * Asserted on the SQL rather than on the result, because a resolver that read every row and
     * returned the first would pass every other test in this file while serving one workspace another
     * workspace's key — which is the worst failure this module could have.
     */
    const { resolve, queries } = resolverFor([claudeRow()]);
    await resolve(CONTEXT);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.params).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(queries[0]?.sql).toMatch(/workspace_id = \$1/);
    /**
     * The modality and active filters are applied **in code**, not in SQL — see the query's own note.
     * A narrow `where` cannot tell "no BYO provider" from "a provider I cannot see", and both are zero
     * rows. So the scoping that must be in SQL is the tenant, and only the tenant.
     */
    expect(queries[0]?.sql).not.toMatch(/modality = 'text'/);
  });

  it("reads the config on every call, so a revoked key stops working at once", async () => {
    /**
     * The reason there is no cache. A TTL would keep a deleted or rotated key working for its duration,
     * and the key a customer has just revoked is precisely the one that must stop being used now.
     */
    const { resolve, queries } = resolverFor([claudeRow()]);
    await resolve(CONTEXT);
    await resolve(CONTEXT);
    await resolve(CONTEXT);
    expect(queries).toHaveLength(3);
  });

  it("treats no row as the platform's model, which is how choosing it is stored", async () => {
    const { resolve } = resolverFor([]);
    await expect(resolve(CONTEXT)).resolves.toBeUndefined();
  });

  it("maps self_hosted to the provider id the platform actually has", async () => {
    /**
     * `MODEL_PROVIDERS` has no `self_hosted`. An unmapped name files the credential under a key nothing
     * reads, so the factory looks configured and the failure arrives inside the first model call.
     */
    const { MODEL_PROVIDERS } = await import("@retinue/agentkit/runtime");
    expect(MODEL_PROVIDERS as readonly string[]).not.toContain("self_hosted");

    const { resolve } = resolverFor([
      { provider: "self_hosted", modality: "text", is_active: true, model: "llama3.1", api_key_encrypted: null, base_url: "https://llm.internal/v1" },
    ]);
    const resolved = await resolve(CONTEXT);
    expect(resolved?.provider).toBe("openai-compatible");
    expect(MODEL_PROVIDERS as readonly string[]).toContain(resolved?.provider);
    expect(resolved?.baseUrl).toBe("https://llm.internal/v1");
    // Self-hosted is the one provider allowed no key.
    expect(resolved?.apiKey).toBeUndefined();
  });

  it("maps every provider the table's check constraint admits", async () => {
    /**
     * The four are not a list this test chose — they are the four
     * `provider in ('google', 'openai', 'anthropic', 'self_hosted')` permits, so a provider added to
     * the table without being mapped here is a row that resolves to nothing and falls silently back to
     * the platform's key.
     */
    for (const provider of ["google", "openai", "anthropic", "self_hosted"]) {
      const { resolve } = resolverFor([
        {
          provider,
          modality: "text",
          is_active: true,
          model: "some-model",
          api_key_encrypted: provider === "self_hosted" ? null : encryptAsWebDoes({ key: "k" }, SECRET),
          base_url: provider === "self_hosted" ? "https://x/v1" : null,
        },
      ]);
      await expect(resolve(CONTEXT), provider).resolves.toBeDefined();
    }
  });

  it("defaults the model per provider when the row names none", async () => {
    const { resolve } = resolverFor([claudeRow({ model: null })]);
    await expect(resolve(CONTEXT)).resolves.toMatchObject({ modelId: "claude-haiku-4-5" });

    const blank = resolverFor([claudeRow({ model: "   " })]);
    await expect(blank.resolve(CONTEXT)).resolves.toMatchObject({ modelId: "claude-haiku-4-5" });
  });

  it("refuses a self-hosted row with no model rather than inventing one", async () => {
    /**
     * A self-hosted endpoint's catalogue is not knowable from here. Defaulting would request a model id
     * from a server nobody here can inspect and get a 404 nobody can explain.
     */
    const { resolve } = resolverFor([
      { provider: "self_hosted", modality: "text", is_active: true, model: null, api_key_encrypted: null, base_url: "https://llm.internal/v1" },
    ]);
    await expect(resolve(CONTEXT)).resolves.toBeUndefined();
  });

  it("refuses a self-hosted row with no base URL", async () => {
    const { resolve } = resolverFor([
      { provider: "self_hosted", modality: "text", is_active: true, model: "llama3.1", api_key_encrypted: null, base_url: null },
    ]);
    await expect(resolve(CONTEXT)).resolves.toBeUndefined();
  });

  it("refuses a cloud provider with no usable key instead of calling it unauthenticated", async () => {
    const missing = resolverFor([claudeRow({ api_key_encrypted: null })]);
    await expect(missing.resolve(CONTEXT)).resolves.toBeUndefined();

    const empty = resolverFor([claudeRow({ api_key_encrypted: encryptAsWebDoes({ key: "" }, SECRET) })]);
    await expect(empty.resolve(CONTEXT)).resolves.toBeUndefined();

    const wrongShape = resolverFor([claudeRow({ api_key_encrypted: encryptAsWebDoes({ token: "x" }, SECRET) })]);
    await expect(wrongShape.resolve(CONTEXT)).resolves.toBeUndefined();
  });

  it("falls back, loudly, when the secret differs from the web app's", async () => {
    /**
     * The deployment mistake this module is most likely to meet: `ENCRYPTION_SECRET` set in `web` and
     * not here, or rotated in one. GCM authenticates, so a wrong key fails rather than returning
     * plausible garbage — and the warning names the variable, because the symptom otherwise is
     * "BYO silently does nothing".
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { resolve } = resolverFor([claudeRow()], { ENCRYPTION_SECRET: "a-different-secret-entirely" });
    await expect(resolve(CONTEXT)).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/ENCRYPTION_SECRET/);
    warn.mockRestore();
  });

  it("warns at construction when there is no secret at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resolverFor([], { ENCRYPTION_SECRET: "" });
    expect(warn.mock.calls.flat().join(" ")).toMatch(/ENCRYPTION_SECRET is not set/);
    warn.mockRestore();
  });

  it("refuses a provider it cannot serve rather than filing the credential under a dead key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { resolve } = resolverFor([claudeRow({ provider: "cohere" })]);
    await expect(resolve(CONTEXT)).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/cohere/);
    warn.mockRestore();
  });

  it("falls back rather than throwing when the table cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolve = createWorkspaceModelResolver({
      sql: {
        query: async () => {
          throw new Error("relation \"workspace_llm_configs\" does not exist");
        },
      } as never,
      env: { ENCRYPTION_SECRET: SECRET },
    });
    await expect(resolve(CONTEXT)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("warns once per workspace, not once per generation", async () => {
    /**
     * A quality loop makes up to six model calls, and a campaign makes many more. A warning per call
     * would bury the rest of a worker's log for one misconfigured workspace.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { resolve } = resolverFor([claudeRow({ provider: "cohere" })]);
    await resolve(CONTEXT);
    await resolve(CONTEXT);
    await resolve(CONTEXT);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("cohere"))).toHaveLength(1);
    warn.mockRestore();
  });
});

/**
 * The silence that cost a debugging session — #462 follow-up.
 *
 * A workspace configured a custom endpoint, generation kept running on the deployment's Google key,
 * and **nothing was logged at all**: the resolver found no matching row and returned `undefined`,
 * which is also exactly what a workspace with no BYO provider does. Those two are the question anybody
 * debugging this is actually asking, and the code could not tell them apart.
 */
describe("saying which of the two silent cases happened", () => {
  it("stays quiet when the workspace genuinely has no provider configured", async () => {
    // The normal case, and by far the most common. A line here would be noise on every generation.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { resolve } = resolverFor([]);
    await expect(resolve(CONTEXT)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    warn.mockRestore();
    info.mockRestore();
  });

  it("says so when configs exist but none is the active text one", async () => {
    /**
     * Somebody who configured a provider for images, or whose text row was deactivated, believes they
     * configured a provider. Before this they got the same total silence as somebody who configured
     * nothing — and their generations ran on the platform's key.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { resolve } = resolverFor([
      claudeRow({ modality: "image" }),
      claudeRow({ modality: "text", is_active: false, provider: "self_hosted", base_url: "https://x/v1", api_key_encrypted: null }),
    ]);
    await expect(resolve(CONTEXT)).resolves.toBeUndefined();
    const said = warn.mock.calls.flat().join(" ");
    expect(said).toMatch(/no active text one/);
    // Names what it did find, which is what turns "it does not work" into a fix.
    expect(said).toMatch(/image=anthropic/);
    expect(said).toMatch(/text=self_hosted \(inactive\)/);
    warn.mockRestore();
  });

  it("announces the model it chose, so a working wire is visible and not merely assumed", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { resolve } = resolverFor([
      claudeRow({ provider: "self_hosted", model: "qwen-plus", base_url: "https://ws-x.aliyuncs.com/compatible-mode/v1", api_key_encrypted: null }),
    ]);
    await expect(resolve(CONTEXT)).resolves.toBeDefined();
    const said = info.mock.calls.flat().join(" ");
    expect(said).toMatch(/openai-compatible/);
    expect(said).toMatch(/qwen-plus/);
    expect(said).toMatch(/ws-x\.aliyuncs\.com/);
    info.mockRestore();
  });

  it("announces once per workspace, not once per model call", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { resolve } = resolverFor([claudeRow()]);
    await resolve(CONTEXT);
    await resolve(CONTEXT);
    await resolve(CONTEXT);
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it("never puts the key in a log line", async () => {
    /**
     * The announcement names the provider, the model and the endpoint — all of which are safe, and all
     * of which somebody debugging needs. The key is none of those things.
     */
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { resolve } = resolverFor([claudeRow({ api_key_encrypted: encryptAsWebDoes({ key: "sk-ant-SECRET-VALUE" }, SECRET) })]);
    await resolve(CONTEXT);
    const everything = [...info.mock.calls, ...warn.mock.calls].flat().join(" ");
    expect(everything).not.toMatch(/SECRET-VALUE/);
    info.mockRestore();
    warn.mockRestore();
  });
});
