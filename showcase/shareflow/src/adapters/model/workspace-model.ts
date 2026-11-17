/**
 * The workspace's own model, resolved per call — closing the BYO gap the cutover recorded and left open (#462).
 *
 * ## What was broken, precisely
 *
 * `shareflow/README.md` carries a dated decision — *"Decision: out of scope for the cutover — Sam
 * Sarwar, 2026-09-08"* — whose consequence it states exactly:
 *
 * > A workspace with a BYO provider configured is served by the platform's model, its key is never
 * > used, and the cost lands on the platform's account. Nothing errors.
 *
 * Everything around that gap shipped anyway. **Settings → AI providers** offers `anthropic` with three
 * Claude models, encrypts the key into `public.workspace_llm_configs`, and reports the provider back.
 * `/api/ai/generate` writes `provider` and `model` into the `agent_runs` audit row and bills
 * `credits_spent: 0` *because* a BYO row exists. So the product asserted, in a stored audit trail and
 * in a billing decision, that a workspace's own provider ran the generation — while every token was
 * spent on `RETINUE_MODEL_API_KEY`.
 *
 * That is worse than an unimplemented feature. An unimplemented feature is absent; this one answered.
 *
 * ## Which of the two recorded options this is
 *
 * The README names both ways to close it. This is the second:
 *
 * > **This backend reads and decrypts the config itself**, which puts `ENCRYPTION_SECRET` in a second
 * > service.
 *
 * Chosen over forwarding the bundle from the web app because the alternative puts a decrypted provider
 * key in a header on **every turn**, crossing the compose network each time, and widens `/api/message`
 * and `/api/tools/:name` into carrying credentials. One extra indexed read per generation is a smaller
 * price than a credential on the wire, and it also covers callers the web app does not mediate.
 *
 * The cost is real and is stated rather than hidden: `ENCRYPTION_SECRET` now lives in two services. It
 * has to be the *same* secret, and a deployment that sets it in one and not the other gets the exact
 * silent fallback this module exists to end — which is why an unset secret warns at construction
 * rather than at the first undecryptable row.
 *
 * ## What this does NOT cover, and it is half the surface
 *
 * **Content generation only.** The assistant's *conversational* turns still run on the deployment's
 * model, because `@retinue/agentkit`'s `resolveModel(manifest, context)` is called **synchronously** —
 * `dist/agents/engine.js:141` is `const resolved = deps.resolveModel(manifest, context)`, not awaited —
 * so a database lookup cannot happen inside it. Returning a promise there would hand the engine a
 * `ResolvedModelInfo` whose `.model` is `undefined`.
 *
 * A synchronous cache primed in the background was rejected: the first turn for any workspace would
 * silently use the platform's key, which is precisely the failure being fixed, only rarer and therefore
 * harder to see. Making that hook awaitable is an upstream change.
 */

import { createDecipheriv, scryptSync } from "node:crypto";

import type { ExecutionContext } from "@retinue/agentkit";
import type { ModelProvider } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

/**
 * The web app's provider names, mapped to the platform's.
 *
 * Three pass through unchanged and one does not: `self_hosted` is the web app's word for *"an
 * OpenAI-shaped endpoint at a base URL I give you"*, which the platform calls `openai-compatible`.
 * Mapping it is not cosmetic — `MODEL_PROVIDERS` does not contain `self_hosted`, and
 * `createProviderFactory` takes `Partial<Record<ModelProvider, ...>>`, so an unmapped name files the
 * credential under a key nothing reads. The factory then looks configured and fails inside the first
 * model call, which is the same class of silent miss this whole module is about.
 *
 * The four keys are exactly the four the table's own check constraint admits
 * (`provider in ('google', 'openai', 'anthropic', 'self_hosted')`), so this map is total by
 * construction rather than by hope. `platform` is not among them: choosing the platform in the UI
 * deletes the row, so "no row" is how that choice is stored.
 */
const PROVIDER_MAP: Readonly<Record<string, ModelProvider>> = {
  google: "google",
  openai: "openai",
  anthropic: "anthropic",
  self_hosted: "openai-compatible",
};

/**
 * The default model per provider, for a row that names a provider and no model.
 *
 * Deliberately **not** imported from `app/model.ts`'s `DEFAULT_MODEL_IDS`, which is a different
 * question: that one defaults *this deployment's* model when `RETINUE_MODEL_ID` is unset, and it is
 * free to track whatever the operator is paying for. This one defaults a *customer's* model, and the
 * customer chose the provider in a dropdown that also offered models — so the safe default is the
 * cheap, current, widely-available one, not the most capable.
 *
 * `openai-compatible` has no default and must not get one: the endpoint is the customer's, and
 * inventing a model id for a server whose catalogue is unknown produces a 404 from a host nobody here
 * can inspect. A self-hosted row without a model is refused instead, with a message saying so.
 */
const DEFAULT_MODEL_BY_PROVIDER: Readonly<Partial<Record<ModelProvider, string>>> = {
  google: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
};

/** A workspace's resolved provider choice. Shaped like `ModelSelection`, plus the endpoint. */
export type WorkspaceModel = {
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
};

/** Resolves a workspace's model, or `undefined` meaning "use this deployment's". */
export type WorkspaceModelResolver = (context: ExecutionContext) => Promise<WorkspaceModel | undefined>;

/**
 * The encryption key, derived exactly as the web app derives it.
 *
 * Transcribed from `web/src/lib/crypto.ts` rather than shared, because the two services are separate
 * packages with separate builds — and a mirrored constant that drifts is caught here by
 * `__tests__/workspace-model.test.ts`, which decrypts a value this file did not encrypt.
 *
 * The dev fallback is mirrored too, and that is a deliberate choice rather than an oversight: without
 * it a local stack with no `ENCRYPTION_SECRET` would encrypt in `web` and fail to decrypt here, which
 * is a BYO feature that works in production and silently does not in development — the worst way round.
 * An unset secret in a real deployment is caught by the warning in `createWorkspaceModelResolver`.
 */
const encryptionKey = (env: Readonly<Record<string, string | undefined>>): Buffer =>
  scryptSync(env["ENCRYPTION_SECRET"] || "dev_secret_key_must_be_32_bytes_long_!!!", "shareflow_salt", 32);

/**
 * `iv:tag:ciphertext`, all hex, AES-256-GCM — the web app's format.
 *
 * Throws on anything malformed, including a wrong secret: GCM authenticates, so a key mismatch fails
 * at `final()` rather than returning plausible garbage. The caller turns that into a named warning and
 * a fallback, which is the only place a decision about it belongs.
 */
const decrypt = (payload: string, key: Buffer): string => {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("not in iv:tag:ciphertext form");
  const [iv, tag, ciphertext] = parts as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return decipher.update(ciphertext, "hex", "utf8") + decipher.final("utf8");
};

type ConfigRow = {
  readonly provider: string;
  readonly modality: string;
  readonly is_active: boolean;
  readonly model: string | null;
  readonly api_key_encrypted: string | null;
  readonly base_url: string | null;
};

/**
 * Build the resolver.
 *
 * One indexed read per generation call, and **no cache**, which is a decision worth defending: a cache
 * would make a rotated or revoked key keep working for its TTL, and a key the customer has just
 * deleted is exactly the one that must stop being used immediately. A generation call is already a
 * multi-second model round trip; a primary-key-shaped lookup beside it is not the cost worth
 * optimising. The *provider client* is memoised instead — see `deployment.ts` — because that was the
 * expense the original "resolved once at boot" comment was actually about.
 */
export const createWorkspaceModelResolver = (deps: {
  readonly sql: SqlExecutor;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): WorkspaceModelResolver => {
  const env = deps.env ?? process.env;

  if ((env["ENCRYPTION_SECRET"] ?? "") === "") {
    /**
     * Warned at construction, not at the first row.
     *
     * A deployment that sets `ENCRYPTION_SECRET` in `web` and not here encrypts keys that this service
     * cannot read, so every BYO workspace falls back to the platform's model — silently, and while
     * being billed zero credits for it. That is the original defect with an extra step, and it would
     * otherwise only be visible to whoever read the per-workspace warning below in the right hour.
     */
    console.warn(
      "[shareflow] ENCRYPTION_SECRET is not set. Workspace BYO provider keys are encrypted with it by " +
        "the web app, so every workspace with its own provider will fall back to this deployment's " +
        "model — and the web app bills those generations as free. Set the same value here as in web.",
    );
  }

  const key = encryptionKey(env);
  /**
   * Said once per workspace per process, so a broken row is visible without flooding a worker log.
   *
   * A quality loop makes up to six model calls and a campaign many more; a line per call would bury
   * everything else for one misconfigured workspace.
   */
  const warned = new Set<string>();
  const warnOnce = (tenantId: string, message: string): void => {
    if (warned.has(tenantId)) return;
    warned.add(tenantId);
    console.warn(`[shareflow] ${message}`);
  };
  const announced = new Set<string>();
  const announceOnce = (tenantId: string, message: string): void => {
    if (announced.has(tenantId)) return;
    announced.add(tenantId);
    console.info(`[shareflow] ${message}`);
  };

  return async (context) => {
    const tenantId = String(context.tenantId);
    let rows: readonly ConfigRow[];
    try {
      /**
       * **Every** row for this workspace, filtered in code rather than in SQL — and that is a
       * deliberate reversal of the obvious query.
       *
       * The narrow `where modality = 'text' and is_active = true` version could not tell "this
       * workspace has no BYO provider" from "this workspace has one and I cannot see it", because both
       * come back as zero rows and the first is the normal case that must stay silent. So a
       * misconfiguration that mattered — a config saved against a different workspace, a row left
       * inactive, a provider configured for the wrong modality — was indistinguishable from the
       * overwhelmingly common case of somebody using the platform's model, and the only symptom was
       * generation quietly running on the deployment's key.
       *
       * That is the exact failure this whole module was written to end, reproduced one level down.
       * Reading the workspace's rows and saying which ones exist costs nothing — the index is on
       * `workspace_id` either way, and a workspace has at most three rows, one per modality.
       */
      rows = await deps.sql.query<ConfigRow>(
        "select provider, modality, is_active, model, api_key_encrypted, base_url " +
          "from public.workspace_llm_configs where workspace_id = $1::uuid",
        [tenantId],
      );
    } catch (error) {
      /**
       * A failed lookup falls back rather than failing the generation.
       *
       * The opposite — refusing to generate because a config table could not be read — would take the
       * whole product down for every workspace over a table most of them have no row in.
       */
      warnOnce(
        tenantId,
        `could not read the BYO provider config for workspace ${tenantId} (${
          error instanceof Error ? error.message : String(error)
        }) — using this deployment's model.`,
      );
      return undefined;
    }

    const row = rows.find((candidate) => candidate.modality === "text" && candidate.is_active);
    if (row === undefined) {
      /**
       * Silent only when there is genuinely nothing configured, which is the normal case.
       *
       * When rows *do* exist and none of them is the active text one, that is somebody who believes
       * they configured a provider — and the difference between those two situations is the whole
       * question anybody debugging this will be asking.
       */
      if (rows.length > 0) {
        warnOnce(
          tenantId,
          `workspace ${tenantId} has ${rows.length} provider config(s) but no active text one, so ` +
            `generation uses this deployment's model. Found: ` +
            rows.map((r) => `${r.modality}=${r.provider}${r.is_active ? "" : " (inactive)"}`).join(", "),
        );
      }
      return undefined;
    }

    const provider = PROVIDER_MAP[row.provider];
    if (provider === undefined) {
      warnOnce(
        tenantId,
        `workspace ${tenantId} names provider "${row.provider}", which this runtime cannot serve — ` +
          `using this deployment's model. Known: ${Object.keys(PROVIDER_MAP).join(", ")}.`,
      );
      return undefined;
    }

    let apiKey: string | undefined;
    if (row.api_key_encrypted !== null && row.api_key_encrypted !== "") {
      try {
        const decoded = JSON.parse(decrypt(row.api_key_encrypted, key)) as { key?: unknown };
        apiKey = typeof decoded.key === "string" && decoded.key !== "" ? decoded.key : undefined;
      } catch (error) {
        warnOnce(
          tenantId,
          `the BYO provider key for workspace ${tenantId} could not be decrypted (${
            error instanceof Error ? error.message : String(error)
          }) — using this deployment's model. This is usually ENCRYPTION_SECRET differing from the web app's.`,
        );
        return undefined;
      }
    }

    /**
     * A cloud provider with no usable key must not win resolution.
     *
     * The same rule `web/src/lib/llm-config.ts` applies, and for the same reason it gives: a keyless
     * row would send unauthenticated calls that come back as confusing 403s and 404s. Restated here
     * rather than relied upon, because this path does not go through that function and a rule enforced
     * in only one of two readers is a rule that holds until someone uses the other one.
     */
    if (provider !== "openai-compatible" && apiKey === undefined) {
      warnOnce(
        tenantId,
        `workspace ${tenantId} has a ${row.provider} config with no usable key — using this ` +
          "deployment's model.",
      );
      return undefined;
    }

    const modelId = row.model !== null && row.model.trim() !== "" ? row.model.trim() : DEFAULT_MODEL_BY_PROVIDER[provider];
    if (modelId === undefined) {
      warnOnce(
        tenantId,
        `workspace ${tenantId} has a self-hosted provider with no model named — using this ` +
          "deployment's model. A self-hosted endpoint's catalogue is not knowable from here, so there " +
          "is no safe default to invent.",
      );
      return undefined;
    }

    const baseUrl = row.base_url !== null && row.base_url.trim() !== "" ? row.base_url.trim() : undefined;
    if (provider === "openai-compatible" && baseUrl === undefined) {
      warnOnce(
        tenantId,
        `workspace ${tenantId} has a self-hosted provider with no base URL — using this deployment's model.`,
      );
      return undefined;
    }

    /**
     * Success is announced, once per workspace.
     *
     * Every *failure* here was already legible and every success was silent, which left "is the BYO
     * wire even running?" unanswerable from a log — the question that actually gets asked, because a
     * workspace on the platform's model and a workspace whose config was never found look identical
     * from outside. One line per workspace per process is the cheapest possible answer.
     */
    announceOnce(
      tenantId,
      `workspace ${tenantId} generates with its own ${provider} model "${modelId}"` +
        `${baseUrl === undefined ? "" : ` at ${baseUrl}`}.`,
    );
    return { provider, modelId, apiKey, baseUrl };
  };
};
