/**
 * The services both compositions use — one factory, so they cannot drift.
 *
 * ## Why this file exists
 *
 * There are two compositions of the ShareFlow app: `module.ts` builds the one the API host serves
 * (`POST /api/tools/:name`, the catalogue, the shadow runner) and `engine.ts` builds the one the
 * **worker** executes every conversation with. They each called `createShareFlowServices` with their
 * own argument list, and the lists were not the same. `engine.ts` passed six fields; `module.ts`
 * passed nine.
 *
 * The three it did not pass were `readMediaBytes`, `storeMedia` and `mermaidBundlePath` — so inside a
 * conversation:
 *
 * - `capture_website`, `render_diagram` and `generate_pdf` could not store what they produced and
 *   refused with *"This deployment cannot store generated files — no media store is configured."*
 * - `read_pdf` and `describe_image` refused the **asset** source, the one a user's own media uses.
 * - `render_diagram` had no mermaid bundle and refused for a second, unrelated reason.
 *
 * Every one of those capabilities passed its verification, because a direct `POST /api/tools/:name`
 * goes through the *host's* composition. The tools worked; the assistant could not use them. That is
 * the second time this exact shape has bitten — see `tools-for-turn.ts` on `execute_tool` — and both
 * times the symptom was a capability that was built, tested, and unreachable from a conversation.
 *
 * `module.ts` already carried the warning, about the shadow runner: *"composing a second app to get
 * them would give the shadow path a different tool surface from the live path. A shadow run that
 * could do things a real one cannot, or vice versa, is not a measurement of anything."* The same
 * sentence applied to the worker and nobody noticed.
 *
 * So the argument list lives here now. A capability added to one composition reaches both, and a
 * dependency neither passes is absent everywhere — which is at least honest.
 */

import { createShareFlowServices } from "../adapters/index.js";
import { connectionSetupFrom } from "./deployment.js";
import { mediaBytesFrom } from "./deployment.js";
import { internalWebAppFrom } from "./internal.js";
import { optionalEnv } from "./env.js";
import { createPexelsClient } from "../adapters/web/pexels.js";
import { webContentGuardFrom } from "../adapters/web/web-guard.js";

export type ShareFlowServicesInput = {
  /** Typed from the factory itself, so this file cannot disagree with it about either. */
  readonly sql: Parameters<typeof createShareFlowServices>[0]["sql"];
  readonly transaction: Parameters<typeof createShareFlowServices>[0]["transaction"];
  /** The web toolkit's two capabilities, already resolved by the caller. */
  readonly search: Parameters<typeof createShareFlowServices>[0]["search"];
  readonly fetchPage: Parameters<typeof createShareFlowServices>[0]["fetchPage"];
  readonly generate: Parameters<typeof createShareFlowServices>[0]["generate"];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The fetch the internal calls use. Defaults to the global one.
   *
   * Here so a test can watch what this factory actually wires up. The wire that broke replying was
   * *absent*, and the wire that broke the media tools was *absent from one of two compositions* — both
   * of which are invisible to a test that only checks a field is defined. With this, an assertion can
   * call the service and read the request.
   */
  readonly fetchImpl?: typeof fetch;
};

export const shareFlowServicesFrom = (input: ShareFlowServicesInput) => {
  const env = input.env ?? process.env;

  /**
   * The web app's internal endpoints, if this deployment was told where they are.
   *
   * `WEB_INTERNAL_URL` plus `SHARED_API_SECRET`. Both are set on every ShareFlow container in the
   * deployed compose file — which is why the worker's missing wiring was invisible from the outside:
   * the environment was right and the code never read it.
   */
  const internal = internalWebAppFrom(env, input.fetchImpl);
  const pexelsKey = optionalEnv("PEXELS_API_KEY", env);
  const webContentGuard = webContentGuardFrom(env, input.fetchImpl);

  return createShareFlowServices({
    sql: input.sql,
    transaction: input.transaction,
    setup: connectionSetupFrom(env),
    /*
     * `connectionSetupFrom` already refuses without `PUBLIC_APP_URL`, so by the time this line runs it
     * is known to be set — the trailing slash is stripped because a link is `{origin}/l/{slug}` and
     * `https://app//l/abc` is a different URL to the one in the database.
     */
    publicAppUrl: (optionalEnv("PUBLIC_APP_URL", env) ?? "").replace(/\/+$/, ""),
    search: input.search,
    fetchPage: input.fetchPage,
    // #667: on by default as the phrase check; see `webContentGuardFrom` for the two settings.
    ...(webContentGuard === undefined ? {} : { webGuard: webContentGuard }),
    /*
     * #615: stock photos and video. The key is read from the environment and goes no further than the
     * client's Authorization header; unset, the stock tools refuse and name the variable.
     */
    ...(pexelsKey === undefined
      ? {}
      : { stockMedia: createPexelsClient({ apiKey: pexelsKey, ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }) }) }),
    /**
     * Present only when the deployment can reach the app.
     *
     * Absent, `read_pdf` and `describe_image` refuse the *asset* source by name and still read a file
     * the user links to — which is the difference between a narrower capability and a broken one.
     */
    ...(internal === undefined
      ? {}
      : {
          readMediaBytes: mediaBytesFrom({ sql: input.sql, internal }),
          // The same hop, the other direction: what the renderers produce is stored through the app.
          storeMedia: internal.storeMedia,
          /**
           * Replying, which had no send at all.
           *
           * `EngagementService.reply` takes an optional `send` and refuses without one: *"This
           * deployment cannot send replies: no platform connector is wired."* That is what a user got
           * when they asked the assistant to answer a comment — after `find_tools`, `learn_tools`,
           * `list_comments` and two `reply_to_comment` attempts. The platform tokens live in the app,
           * which already has the connector and the endpoint the old runtime used; nothing connected
           * the two.
           */
          sendReply: internal.sendReply,
          /**
           * Deleting from the platform, which `delete_post` could not reach — #451.
           *
           * The fifth instance of the shape this file keeps recording: `PublishingDeps.deleteFrom` was
           * declared, `deletePublished` branched on it, and nobody supplied it — so the tool answered
           * *"This deployment cannot delete published posts: no platform connector is wired"* on a
           * deployment whose connectors delete posts every day from the app's own button.
           *
           * Only the platform half. `deletePublished` keeps the rows, because it refuses the whole
           * delete when a platform will not co-operate — a row removed while the post is still live is
           * a live post nobody can find again.
           */
          deletePostFrom: internal.deleteFromPlatform,
          /**
           * Connector health, which could not be answered at all — #451.
           *
           * Both of these are facts only the app's process holds. `configuredPlatforms` is a read of
           * its environment: whether `linkedin` has credentials is not in any row, and an account
           * exists whether or not the platform's app credentials do. `probe` is a live call, because
           * `check_account_health` promises one — the model reaches for it exactly when the stored
           * status is the thing under suspicion.
           */
          /**
           * The media path, proven end to end — #451.
           *
           * `check_media_storage` refused everywhere, so an unpublishable bucket was discovered at
           * publish time, on a post already sent. The check has to fetch **anonymously**, which needs
           * the signing key and an outbound request — neither of which is in this package.
           */
          checkMediaStorage: (input) => internal.checkMediaStorage({ context: input.context }),
          /**
           * The lead opt-out list — #451, the last of the five.
           *
           * Checked before every insert and ahead of the dedupe, because "opted out" is a stronger
           * answer than "already here". With no supplier it never fired, so `capture_lead` could not
           * refuse anybody and the `suppressed` arm of `LeadCreateResult` was unreachable.
           *
           * `name` is deliberately not forwarded. The list is keyed on address; matching a name would
           * suppress every person who shares one and report it as that individual's own opt-out.
           */
          isSuppressed: (input) =>
            internal.isLeadSuppressed({
              context: input.context,
              ...(input.email === undefined ? {} : { email: input.email }),
            }),
          configuredPlatforms: (context) => internal.configuredPlatforms({ context }),
          probe: (input) => internal.probeAccount({ context: input.context, accountId: input.accountId }),
          /**
           * "Publish now" that means now — #403.
           *
           * `PublishingDeps.enqueue` had two call sites and no supplier, so an assistant publish wrote a
           * PENDING row and waited for the reconciliation sweep: five minutes of grace plus a cron tick,
           * where the same action in the app took seconds. Both reported success immediately, which is what
           * kept it invisible.
           *
           * Present only when the deployment can reach the app, like everything else in this block — absent,
           * the sweep is still there and the post is late rather than lost.
           */
          enqueue: internal.enqueuePublish,
          /**
           * Conversion, which had a route, a dep and no wire — #320.
           *
           * `MediaDeps.convert` was declared and the adapter referenced it twelve times; `convert-media`
           * had shipped as a route; this block never mentioned it. So `convert_media` answered *"this
           * deployment cannot convert media"* on a container where `WEB_INTERNAL_URL` was set — checked
           * against the running image, where `dist/app/services.js` contained no occurrence of the word.
           *
           * Third instance of the same shape in this file. The two above it are `sendReply` and
           * `enqueue`; the pattern is a capability that is complete on both sides and joined on neither.
           */
          /**
           * The recurring-schedule writes — #425, wired a commit late.
           *
           * `ScheduleService` reads from Postgres and writes only through the app, because
           * materialising a rule into occurrences is ShareFlow's logic. The route shipped with the
           * feature; this line did not, so both writes answered `noWriteHop()` — *"no route to the
           * app"* — on a deployment that had one. The tools were registered and the tool sweep skips
           * both as side-effecting, so nothing called them.
           */
          scheduleWrite: internal.schedules,
          convertMedia: internal.convertMedia,
          // #496: media generation runs in the app (Higgsfield or built-in); the agent starts and reads jobs.
          // #499: caption tools check and spend Chorus credits through the app, which owns the ledger.
          checkCredits: internal.checkCredits,
          chargeCredits: internal.chargeCredits,
          generateMedia: internal.generateMedia,
          // #525: templates are drawn and stored by the app, in the conversation's project.
          renderProjectTemplate: internal.renderProjectTemplate,
          // #553: project changes and brand reading go through the app, which validates and checks egress.
          updateProject: internal.updateProject as never,
          extractBrandKit: internal.extractBrandKit,
          getMediaGeneration: internal.getMediaGeneration,
          /**
           * The platform media rules — #320 AC-8.
           *
           * Absent, the three draft media writes refuse rather than allowing an edit they cannot check.
           * The app has refused these on the same operation since `writeMedia` existed; until this was
           * wired the assistant was the single path that did not, so it could attach a video to a
           * platform that takes none and the failure arrived at publish time.
           */
          checkMediaCompatibility: internal.checkMediaCompatibility,

        }),
    /**
     * The mermaid bundle's path, from the environment.
     *
     * `RETINUE_MERMAID_BUNDLE` mirrors the old runtime's `MERMAID_BUNDLE_PATH`, and the Dockerfile
     * sets it. Absent — a checkout, or an image built without the copy — `render_diagram` refuses.
     */
    ...(optionalEnv("RETINUE_MERMAID_BUNDLE", env) === undefined
      ? {}
      : { mermaidBundlePath: optionalEnv("RETINUE_MERMAID_BUNDLE", env) }),
    generate: input.generate,
  });
};
