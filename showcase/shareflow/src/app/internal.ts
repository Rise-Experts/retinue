/**
 * Calling the web app's `/api/internal/*` endpoints — the hop that exists because of what this
 * container deliberately does not hold.
 *
 * ## Why there is a hop at all
 *
 * `store-media`'s own header says it: *"ai_backend has no service-role key — its env carries only the
 * anon key — so it cannot write to the private media bucket. Giving it one would widen its blast radius
 * considerably for the sake of one upload. The web app already holds that key for the publish path."*
 * The same is true here, and more so: this container's env has **no Supabase URL or key at all**,
 * checked on the running deployment. So signing and storing happen on the side that already holds the
 * credential, and the workspace-prefix check that authorises a path lives there too.
 *
 * ## What this is not
 *
 * Not a general HTTP client and not on the egress policy's path. These are calls to *one configured
 * host* with a shared secret, and the endpoint names are literals in this file — never a model's
 * argument. That is the difference the platform's own egress header draws: a policy exists because a
 * *model* chooses the URL, and here nobody does.
 *
 * Absent configuration means **absent capability**, the same shape as `MediaDeps.convert`: a deployment
 * without `WEB_INTERNAL_URL` and `SHARED_API_SECRET` gets tools that refuse by name rather than a client
 * that posts to nowhere.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";

import type { PostTemplateId } from "../services/index.js";
import { optionalEnv } from "./env.js";

/** How long one internal call may take. Storing a 20 MB PDF is a real upload, not a metadata write. */
export const INTERNAL_TIMEOUT_MS = 30_000;

export type StoredMedia = {
  /** The object key inside the media bucket. Never leaves the backend — see `MediaService`. */
  readonly path: string;
  /** The `chorus-media:` reference a caller can put in a reply or attach to a post. */
  readonly reference: string;
};

export type InternalWebApp = {
  /** Store bytes in the workspace's media bucket. */
  storeMedia(input: {
    readonly context: ExecutionContext;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<StoredMedia>;
  /**
   * Sign one workspace-scoped object so it can be fetched.
   *
   * Takes a **path**, which is what the endpoint authorises on: *"the authorization boundary here is the
   * workspace prefix on `path`"*. The caller reads that path from the database under its own tenant
   * scope; a path never arrives from a model.
   */
  signMediaUrl(input: { readonly context: ExecutionContext; readonly path: string }): Promise<string>;
  /**
   * Queue a media conversion — #320. Returns the job to follow, not the finished file.
   *
   * Declared here because `MediaDeps.convert` was declared, referenced twelve times, and supplied by
   * nobody: the deployed composition had no reference to `convertMedia` at all.
   */
  /**
   * Create and cancel recurring schedules through the app — #425.
   *
   * The rule's materialisation is ShareFlow's: creating one writes the rule *and* the occurrences it
   * implies, which is app-side logic this package does not hold. `ScheduleService` therefore reads from
   * Postgres and writes only through here.
   *
   * Declared late, and that is the bug: the route shipped, `scheduleWrite` was declared, and the
   * composition supplied it nowhere — so both schedule writes refused on a deployment where the route
   * was live. It was reported as verified because the *tools* were registered, which they were.
   */
  schedules: {
    create(input: {
      readonly context: ExecutionContext;
      readonly body: Record<string, unknown>;
    }): Promise<{ schedule: Record<string, unknown>; materialised: number }>;
    cancel(input: {
      readonly context: ExecutionContext;
      readonly scheduleId: string;
    }): Promise<{ cancelled: number | true }>;
  };
  convertMedia(input: {
    readonly context: ExecutionContext;
    readonly assetId: string;
    readonly sourcePath: string;
    readonly targetFormat: string;
  }): Promise<{ readonly jobId: string }>;
  /** Draw a template in the conversation's project kit and save it to the project — #525 (`/api/internal/project-templates`). */
  renderProjectTemplate(input: {
    readonly context: ExecutionContext;
    readonly template: PostTemplateId;
    readonly text: string;
    readonly slides?: readonly string[];
    readonly imageAssetId?: string;
  }): Promise<{ readonly assets: readonly { readonly id: string; readonly label: string }[] }>;
  /** Change the conversation's project — #553 (`/api/internal/project-update`). The app validates and checks the writer. */
  updateProject(input: { readonly context: ExecutionContext; readonly patch: Record<string, unknown> }): Promise<{ readonly projectId: string; readonly changed: readonly string[] }>;
  /** Read a website's brand signals behind the app's egress checks — #553 (`/api/internal/brand-kit`). */
  extractBrandKit(input: { readonly context: ExecutionContext; readonly url: string }): Promise<{
    readonly url: string;
    readonly title?: string;
    readonly description?: string;
    readonly colors: readonly string[];
    readonly fonts: readonly string[];
    readonly logoUrl?: string;
    readonly imageUrl?: string;
    readonly language?: string;
  }>;
  /** Start a media generation in the app — #496 (`/api/internal/generate-media`, action `start`). */
  generateMedia(input: {
    readonly context: ExecutionContext;
    readonly kind: "image" | "video";
    readonly prompt: string;
    readonly model?: string;
    readonly aspectRatio?: string;
    readonly count?: number;
    readonly postId?: string;
    readonly referencePaths?: readonly string[];
  }): Promise<{ readonly jobId: string; readonly provider?: string }>;
  /** Whether a tool may spend `credits` now — #499 (`/api/internal/credits`, action `check`). Refuses with the plan's message. */
  checkCredits(input: { readonly context: ExecutionContext; readonly credits: number; readonly tool: string }): Promise<{ readonly byo: boolean }>;
  /** Record what a finished tool spent — #499 (action `charge`). A BYO workspace is charged nothing. */
  chargeCredits(input: { readonly context: ExecutionContext; readonly credits: number; readonly tool: string }): Promise<{ readonly charged: number }>;
  /**
   * Record a completed chat turn — #597 (action `charge_turn`). The app prices it and charges it once per
   * run; `workspaceModel` says whether the workspace's own model served it, which waives it.
   */
  chargeTurn(input: { readonly workspaceId: string; readonly runId: string; readonly workspaceModel?: boolean; readonly conversationId?: string }): Promise<{ readonly charged: number }>;
  /** Read a media generation back — #496 (action `status`). */
  getMediaGeneration(input: { readonly context: ExecutionContext; readonly jobId: string }): Promise<unknown>;
  /**
   * Ask the app whether a media list is publishable to the given platforms — #320 AC-8.
   *
   * Returns the problems, empty when there are none. The rule is the publish gate's own, so a swap the
   * assistant allows cannot be one the publish then refuses.
   */
  checkMediaCompatibility(input: {
    readonly context: ExecutionContext;
    readonly platforms: readonly string[];
    readonly paths: readonly string[];
  }): Promise<readonly { readonly platform: string; readonly reason: string }[]>;
  /**
   * Hand an already-written `scheduled_items` row to the app's publishing queue — #403.
   *
   * The queue is ShareFlow's, and it stays ShareFlow's: this package has no Redis dependency and must not
   * become a second producer for a queue it does not own. What it gains is the ability to say "now" over the
   * hop it already uses for media and replies, instead of writing a row and waiting for the reconciliation
   * sweep to notice — five minutes of grace plus a cron tick, against seconds for the same action taken in
   * the app.
   *
   * Best effort by contract, and the caller treats it that way: the row is written and committed first, so a
   * refusal here makes a post late rather than lost.
   */
  enqueuePublish(input: {
    readonly context: ExecutionContext;
    readonly scheduledItemId: string;
    readonly delayMs: number;
  }): Promise<void>;
  /**
   * Send a comment reply the runtime has **already claimed** in the database.
   *
   * The platform tokens live in the web app and deliberately not here — the same reason `storeMedia`
   * is a call rather than a Supabase client: "giving it one would widen its blast radius considerably".
   * So `EngagementService.reply` needs a `send`, and with none it refused every reply with *"this
   * deployment cannot send replies: no platform connector is wired"*, which is what a user saw when
   * they asked the assistant to answer a comment.
   *
   * `send-reply`, not `reply`: the runtime marks the row `sent` before sending, so the app's own
   * `reply` action refuses it as already answered. This action performs the platform call and leaves
   * the row alone.
   */
  /**
   * Take one published post down from one platform — #451.
   *
   * The same seam as `sendReply`: ShareFlow's connectors live in the app's repository, so this asks
   * the app to do it. Only the platform half — `deletePublished` owns the rows, because it has to
   * refuse the whole delete when a platform will not co-operate.
   *
   * `deleted: false` with a reason is a **normal answer**. TikTok has no delete API and Instagram
   * refuses ads and carousel children; throwing for those would turn "this platform cannot" into
   * "the call failed".
   */
  /**
   * Which platforms this deployment actually has credentials for — #451.
   *
   * A read of the *app's* environment, which this container cannot see and a `social_accounts` row
   * cannot stand in for: an account exists whether or not the platform's app credentials do. Without
   * it `not-configured` was never reported for anything — which the port is careful to note is not
   * the same as everything being configured.
   */
  /**
   * Walk the media path the way a platform will — #451.
   *
   * Writes a diagnostic object, signs a URL and fetches it **anonymously**, because the platforms
   * fetch media as strangers: a private bucket works for every authenticated call this system makes
   * and fails only at publish time, on a post already sent.
   */
  checkMediaStorage(input: { readonly context: ExecutionContext }): Promise<{
    readonly ok: boolean;
    readonly stage: "config" | "upload" | "public-read" | "complete";
    readonly missing?: readonly string[];
    readonly hint?: string;
  }>;
  /**
   * Is this address on the workspace's lead opt-out list — #451.
   *
   * `undefined` means "not suppressed" and is only ever returned when the list was actually read.
   * A read that FAILS throws, because the alternative — reporting "not suppressed" for a question
   * nobody could answer — captures somebody who opted out and tells the user it went fine.
   */
  isLeadSuppressed(input: {
    readonly context: ExecutionContext;
    readonly email?: string;
  }): Promise<"opt-out" | "complaint" | "existing-customer" | "manual" | undefined>;
  configuredPlatforms(input: { readonly context: ExecutionContext }): Promise<readonly string[]>;
  /**
   * Re-check one account against its platform — #451.
   *
   * `check_account_health` promises *"re-check against their platform, rather than reading the stored
   * status"*, and the model calls it exactly when the stored status is under suspicion. Answering
   * from the store would be a false claim the assistant then relays to somebody.
   */
  probeAccount(input: {
    readonly context: ExecutionContext;
    readonly accountId: string;
  }): Promise<"active" | "expired" | "not-configured" | "revoked">;
  deleteFromPlatform(input: {
    readonly context: ExecutionContext;
    readonly accountId: string;
    readonly platformId: string;
    readonly externalPostId: string;
  }): Promise<{ readonly deleted: boolean; readonly reason?: string }>;
  sendReply(input: {
    readonly context: ExecutionContext;
    readonly commentId: string;
    readonly text: string;
  }): Promise<void>;
};

export type InternalWebAppConfig = {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetchImpl?: typeof fetch;
};

/**
 * The client, or `undefined` when this deployment has not been given one.
 *
 * `undefined` rather than a client that throws on use, because the *tools* branch on whether the
 * dependency exists — a present-but-broken client would turn a configuration gap into a runtime error
 * on the first call, which is the pattern this package keeps replacing with a named refusal.
 */
export const internalWebAppFrom = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: typeof fetch,
): InternalWebApp | undefined => {
  const baseUrl = optionalEnv("WEB_INTERNAL_URL", env);
  const secret = optionalEnv("SHARED_API_SECRET", env);
  if (baseUrl === undefined || secret === undefined) return undefined;
  return createInternalWebApp({ baseUrl, secret, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
};

export const createInternalWebApp = (config: InternalWebAppConfig): InternalWebApp => {
  const call = async (
    endpoint:
      | "store-media"
      | "media-url"
      | "post-ops"
      | "enqueue-publish"
      | "convert-media"
      | "post-media"
      | "schedules"
      | "connector-health"
      | "leads"
      | "generate-media"
      | "project-templates"
      | "project-update"
      | "brand-kit"
      | "credits",
    body: Record<string, unknown>,
    /*
     * POST for everything except cancelling a schedule, which the route exposes as DELETE. Passing the
     * method rather than adding a second client keeps one place that signs, times out and unwraps the
     * app's own error message.
     */
    method: "POST" | "DELETE" = "POST",
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INTERNAL_TIMEOUT_MS);
    let response: Response;
    try {
      response = await (config.fetchImpl ?? fetch)(`${config.baseUrl.replace(/\/+$/, "")}/api/internal/${endpoint}`, {
        method,
        headers: {
          "content-type": "application/json",
          /**
           * `x-internal-secret`, which the guard accepts alongside `x-api-secret`.
           *
           * The more specific of the two names: `x-api-secret` is what the web app sends *outbound* to a
           * backend, and reusing it inbound reads as a reply to itself in a log.
           */
          "x-internal-secret": config.secret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new AgentPlatformError({
        code: aborted ? "timeout" : "provider_unavailable",
        message: aborted
          ? `The app did not answer within ${INTERNAL_TIMEOUT_MS / 1_000} seconds.`
          : `The app could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      /**
       * The endpoint's own message, when it sent one.
       *
       * A path outside the workspace answers 403 with a reason, and *"that file could not be opened"*
       * is a better thing to tell a person than "the app returned 403". A 401 means this deployment's
       * secret does not match the app's, which is a configuration fault and is named as one.
       */
      const named = (payload as { error?: unknown } | undefined)?.error;
      throw new AgentPlatformError({
        code: response.status === 401 ? "provider_unavailable" : response.status < 500 ? "invalid_input" : "provider_error",
        message:
          response.status === 401
            ? "This deployment's internal secret does not match the app's, so it cannot reach the app."
            : typeof named === "string"
              ? named
              : `The app answered ${response.status}.`,
        retryable: response.status >= 500,
      });
    }
    return payload;
  };

  return {
    async storeMedia(input) {
      const payload = (await call("store-media", {
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        contentType: input.contentType,
        // The endpoint takes base64; `Buffer` is Node's, and this file only ever runs in the container.
        dataBase64: Buffer.from(input.bytes).toString("base64"),
      })) as { path?: unknown; reference?: unknown } | undefined;

      const path = typeof payload?.path === "string" ? payload.path : "";
      const reference = typeof payload?.reference === "string" ? payload.reference : "";
      if (path === "" || reference === "") {
        /**
         * A 200 without both fields is a broken contract, not a stored file.
         *
         * Returning an empty reference would put "the diagram is at " in a reply, and the caller would
         * have no way to tell that from a stored image.
         */
        throw new AgentPlatformError({
          code: "provider_error",
          message: "The app stored the file but did not say where.",
          retryable: true,
        });
      }
      return { path, reference };
    },

    /**
     * Send a reply through the app, which is where the platform credentials live.
     *
     * Returns nothing: the runtime has already written the row, and the only question is whether the
     * platform accepted it. A throw is the answer when it did not, and the error carries the app's own
     * message — "Replying is not supported on linkedin yet", "The account for that comment is no longer
     * connected" — which is more use to a reader than a status code.
     */
    async isLeadSuppressed(input) {
      /*
       * No email, nothing to match on. Asked and answered here rather than over the wire: the list
       * is keyed on address, and a name is not an identifier — suppressing everybody who shares one
       * would be reported to the user as that individual having opted out.
       */
      if (input.email === undefined || input.email === "") return undefined;

      const payload = (await call("leads", {
        action: "suppression-check",
        workspaceId: String(input.context.tenantId),
        email: input.email,
      })) as { reason?: unknown } | undefined;

      const reason = payload?.reason;
      return reason === "opt-out" || reason === "complaint" || reason === "existing-customer" || reason === "manual"
        ? reason
        : undefined;
    },

    async checkMediaStorage(input) {
      const payload = (await call("post-media", {
        action: "storage-check",
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
      })) as { ok?: unknown; stage?: unknown; missing?: unknown; hint?: unknown } | undefined;

      const stage =
        payload?.stage === "config" || payload?.stage === "upload" || payload?.stage === "public-read" || payload?.stage === "complete"
          ? payload.stage
          : "config";
      return {
        // An unreadable answer is not `ok`. This tool exists to catch a path that fails silently;
        // defaulting to healthy would make it one more thing that does.
        ok: payload?.ok === true,
        stage,
        ...(Array.isArray(payload?.missing) ? { missing: payload.missing.filter((m): m is string => typeof m === "string") } : {}),
        ...(typeof payload?.hint === "string" && payload.hint !== "" ? { hint: payload.hint } : {}),
      };
    },

    async configuredPlatforms(input) {
      const payload = (await call("connector-health", {
        action: "configured",
        workspaceId: String(input.context.tenantId),
      })) as { platforms?: unknown } | undefined;
      return Array.isArray(payload?.platforms)
        ? payload.platforms.filter((p): p is string => typeof p === "string")
        : [];
    },

    async probeAccount(input) {
      const payload = (await call("connector-health", {
        action: "probe",
        workspaceId: String(input.context.tenantId),
        accountId: input.accountId,
      })) as { health?: unknown } | undefined;
      const health = payload?.health;
      /**
       * An unreadable answer is **not** `active`.
       *
       * This is called when somebody already suspects the account is broken; defaulting to healthy
       * would answer the one question it exists to answer with the one value that ends the
       * investigation.
       */
      return health === "active" || health === "expired" || health === "not-configured" || health === "revoked"
        ? health
        : "expired";
    },

    async deleteFromPlatform(input) {
      const payload = (await call("post-ops", {
        action: "delete-from-platform",
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        accountId: input.accountId,
        platform: input.platformId,
        externalPostId: input.externalPostId,
      })) as { deleted?: unknown; reason?: unknown } | undefined;

      /**
       * A missing or unreadable answer is **not deleted**, deliberately.
       *
       * `deletePublished` removes the row only when every target reports `deleted`, so defaulting to
       * true here would delete the record of a post still live on a platform — the exact failure the
       * whole delete path is arranged to prevent.
       */
      const deleted = payload?.deleted === true;
      const reason = typeof payload?.reason === "string" && payload.reason !== "" ? payload.reason : undefined;
      return deleted ? { deleted: true } : { deleted: false, reason: reason ?? "the app did not confirm the delete" };
    },

    async sendReply(input) {
      await call("post-ops", {
        action: "send-reply",
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        commentId: input.commentId,
        text: input.text,
      });
    },

    async enqueuePublish(input) {
      await call("enqueue-publish", {
        workspaceId: String(input.context.tenantId),
        scheduledItemId: input.scheduledItemId,
        delayMs: input.delayMs,
      });
    },

    /**
     * Run a conversion through the app — #320.
     *
     * **This hop did not exist.** `MediaDeps.convert` was declared, the adapter referenced it twelve
     * times, `convert-media` had shipped as a route, and nothing connected the two: the deployed
     * composition contained no reference to `convertMedia` at all, so `convert_media` answered *"this
     * deployment cannot convert media"* on a container where `WEB_INTERNAL_URL` was set. The
     * environment was right and the code never read it — the third time that sentence has been
     * written in this package.
     *
     * It matters beyond the one tool: `replace_media_on_post` tells the model to *"use this after
     * `convert_media` to put the converted file where the incompatible original was"*, so the repair
     * path for an incompatible attachment ended at a refusal.
     *
     * The route answers 202 with `{ jobId, status }`; the job is finished later and read back through
     * `check_conversion`.
     */
    schedules: {
      async create(input) {
        const payload = (await call("schedules", {
          ...input.body,
          workspaceId: String(input.context.tenantId),
          userId: String(input.context.principalId),
        })) as { schedule?: unknown; materialised?: unknown } | undefined;
        const schedule = (payload?.schedule ?? {}) as Record<string, unknown>;
        const materialised = typeof payload?.materialised === "number" ? payload.materialised : 0;
        return { schedule, materialised };
      },
      async cancel(input) {
        const payload = (await call(
          "schedules",
          { workspaceId: String(input.context.tenantId), scheduleId: input.scheduleId },
          "DELETE",
        )) as { cancelled?: unknown } | undefined;
        return { cancelled: typeof payload?.cancelled === "number" ? payload.cancelled : true };
      },
    },

    async renderProjectTemplate(input) {
      const payload = (await call("project-templates", {
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        conversationId: input.context.conversationId === undefined ? "" : String(input.context.conversationId),
        template: input.template,
        text: input.text,
        ...(input.slides === undefined ? {} : { slides: input.slides }),
        ...(input.imageAssetId === undefined ? {} : { imageAssetId: input.imageAssetId }),
      })) as { assets?: unknown } | undefined;
      const assets = Array.isArray(payload?.assets)
        ? (payload.assets as unknown[]).filter((a): a is { id: string; label: string } =>
            typeof (a as { id?: unknown })?.id === "string" && typeof (a as { label?: unknown })?.label === "string")
        : [];
      if (assets.length === 0) {
        throw new AgentPlatformError({ code: "provider_error", message: "The app did not render the template.", retryable: true });
      }
      return { assets: assets.map((a) => ({ id: a.id, label: a.label })) };
    },

    async updateProject(input) {
      const payload = (await call("project-update", {
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        conversationId: input.context.conversationId === undefined ? "" : String(input.context.conversationId),
        patch: input.patch,
      })) as { projectId?: unknown; changed?: unknown } | undefined;
      if (typeof payload?.projectId !== "string") {
        throw new AgentPlatformError({ code: "provider_error", message: "The app did not change the project.", retryable: true });
      }
      return {
        projectId: payload.projectId,
        changed: Array.isArray(payload.changed) ? payload.changed.filter((c): c is string => typeof c === "string") : [],
      };
    },

    async extractBrandKit(input) {
      const payload = (await call("brand-kit", { workspaceId: String(input.context.tenantId), url: input.url })) as Record<string, unknown> | undefined;
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
      if (payload === undefined || typeof payload["url"] !== "string") {
        throw new AgentPlatformError({ code: "provider_error", message: "The app did not read that website.", retryable: true });
      }
      const kit = {
        url: payload["url"] as string,
        title: str(payload["title"]),
        description: str(payload["description"]),
        colors: strings(payload["colors"]),
        fonts: strings(payload["fonts"]),
        logoUrl: str(payload["logoUrl"]),
        imageUrl: str(payload["imageUrl"]),
        language: str(payload["language"]),
      };
      return Object.fromEntries(Object.entries(kit).filter(([, v]) => v !== undefined)) as typeof kit & { colors: string[]; fonts: string[] };
    },

    async generateMedia(input) {
      const payload = (await call("generate-media", {
        action: "start",
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        kind: input.kind,
        prompt: input.prompt,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
        ...(input.count === undefined ? {} : { count: input.count }),
        ...(input.postId === undefined ? {} : { postId: input.postId }),
        // #575: the person's own reference images; the app checks each is in this workspace.
        ...(input.referencePaths === undefined ? {} : { referencePaths: input.referencePaths }),
        // #524: the app finds the conversation's project avatar and sends its reference photos along.
        ...(input.context.conversationId === undefined ? {} : { conversationId: String(input.context.conversationId) }),
      })) as { jobId?: unknown; provider?: unknown } | undefined;
      if (typeof payload?.jobId !== "string") {
        throw new AgentPlatformError({ code: "provider_error", message: "The app did not start a media job.", retryable: true });
      }
      return { jobId: payload.jobId, ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}) };
    },

    async checkCredits(input) {
      const payload = (await call("credits", {
        action: "check",
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        credits: input.credits,
        tool: input.tool,
      })) as { byo?: unknown } | undefined;
      return { byo: payload?.byo === true };
    },

    async chargeCredits(input) {
      const payload = (await call("credits", {
        action: "charge",
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        credits: input.credits,
        tool: input.tool,
        // What the composer's "N credits used" reads back, per turn.
        ...(input.context.runId === undefined ? {} : { runId: String(input.context.runId) }),
        ...(input.context.conversationId === undefined ? {} : { conversationId: String(input.context.conversationId) }),
      })) as { charged?: unknown } | undefined;
      return { charged: typeof payload?.charged === "number" ? payload.charged : 0 };
    },

    async chargeTurn(input) {
      const payload = (await call("credits", {
        action: "charge_turn",
        workspaceId: input.workspaceId,
        runId: input.runId,
        ...(input.workspaceModel === undefined ? {} : { workspaceModel: input.workspaceModel }),
        // #646: stored on the charge, so "this chat: N credits" can add it up.
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      })) as { charged?: unknown } | undefined;
      return { charged: typeof payload?.charged === "number" ? payload.charged : 0 };
    },

    async getMediaGeneration(input) {
      return call("generate-media", { action: "status", workspaceId: String(input.context.tenantId), jobId: input.jobId });
    },

    async convertMedia(input) {
      const payload = (await call("convert-media", {
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        path: input.sourcePath,
        to: input.targetFormat,
      })) as { jobId?: unknown } | undefined;
      const jobId = typeof payload?.jobId === "string" ? payload.jobId : "";
      if (jobId === "") {
        throw new AgentPlatformError({
          code: "provider_error",
          message: "The app accepted the conversion but did not say which job to follow.",
          retryable: true,
        });
      }
      return { jobId };
    },

    /**
     * The platform media rules, asked of the app rather than reimplemented here — #320 AC-8.
     *
     * `post-media`'s `check` action runs `validateMediaForPlatform`, which is the same function the
     * publish gate uses. Asking for it keeps one rule: a swap the assistant allows and a publish that
     * then refuses cannot disagree, because there is nothing to disagree with.
     *
     * Reimplementing it here was the alternative, and this package already carries a comment about a
     * cadence that existed in two vocabularies for exactly that reason.
     */
    async checkMediaCompatibility(input) {
      const payload = (await call("post-media", {
        action: "check",
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        platforms: [...input.platforms],
        paths: [...input.paths],
      })) as { ok?: unknown; problems?: unknown } | undefined;
      const problems = Array.isArray(payload?.problems) ? payload.problems : [];
      return problems
        .map((entry) => entry as { platform?: unknown; reason?: unknown })
        .filter((entry) => typeof entry.reason === "string" && entry.reason !== "")
        .map((entry) => ({ platform: String(entry.platform ?? ""), reason: String(entry.reason) }));
    },

    async signMediaUrl(input) {
      const payload = (await call("media-url", {
        workspaceId: String(input.context.tenantId),
        userId: String(input.context.principalId),
        path: input.path,
      })) as { url?: unknown } | undefined;
      const url = typeof payload?.url === "string" ? payload.url : "";
      if (url === "") {
        throw new AgentPlatformError({ code: "provider_error", message: "That file could not be opened.", retryable: true });
      }
      return url;
    },
  };
};
