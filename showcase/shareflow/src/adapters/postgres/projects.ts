import type { ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";
import { AgentPlatformError } from "@retinue/agentkit";
import type { ActiveProject, BrandKit, MediaService, ProjectAsset, ProjectPatch, ProjectService, ProjectThemeKeys, TemplateRenderInput } from "../../services/index.js";

/**
 * The conversation's Compose project — #522, read from the tables #520 created.
 *
 * Scoped three ways, all in the query: the workspace, the conversation's link, and — for a personal
 * project — the caller being its owner, the same rule the app's row-level security applies. An archived
 * project still applies to the chats already in it: archiving hides a project from the list, it does
 * not silently change how its conversations behave.
 */
type Row = { id: string; name: string; instructions: string; defaults: Record<string, unknown> | null; avatar?: Record<string, unknown> | null; design?: Record<string, unknown> | null };

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

export type ProjectDeps = {
  readonly sql: SqlExecutor;
  /** The media service's attach-by-path, so a project file goes through the same checks as any media. */
  readonly attachPaths?: MediaService["attachPathsToDraft"];
  /** #553: the app validates and writes project changes (`/api/internal/project-update`); absent, updating refuses. */
  readonly updateProject?: (input: { readonly context: ExecutionContext; readonly patch: ProjectPatch }) => Promise<{ readonly projectId: string; readonly changed: readonly string[] }>;
  /** #553: the app reads a website's HTML behind its egress checks (`/api/internal/brand-kit`). */
  readonly extractBrandKit?: (input: { readonly context: ExecutionContext; readonly url: string }) => Promise<BrandKit>;
  /** #525: the app draws and stores templates (`/api/internal/project-templates`); absent, rendering refuses. */
  readonly renderTemplate?: (input: { readonly context: ExecutionContext } & TemplateRenderInput) => Promise<{ readonly assets: readonly { readonly id: string; readonly label: string }[] }>;
};

/**
 * #595: the theme keys, carried as stored — the shape checked, the values left to `resolveTheme`, which
 * falls back per key. Dropping a bad value here would hide it from the one reader that explains it.
 */
const themeKeys = (d: Record<string, unknown>): ProjectThemeKeys => {
  const obj = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const palette = Object.fromEntries(Object.entries(obj(d["palette"]) ?? {}).filter(([, v]) => text(v) !== undefined));
  const picture = obj(d["picture"]) ?? {};
  const pictureKeys = {
    ...(text(picture["style"]) === undefined ? {} : { style: text(picture["style"])! }),
    ...(text(picture["mood"]) === undefined ? {} : { mood: text(picture["mood"])! }),
  };
  return {
    ...(text(d["themeId"]) === undefined ? {} : { themeId: text(d["themeId"])! }),
    ...(Object.keys(palette).length === 0 ? {} : { palette: palette as ProjectThemeKeys["palette"] }),
    ...(text(d["headingFont"]) === undefined ? {} : { headingFont: text(d["headingFont"])! }),
    ...(text(d["bodyFont"]) === undefined ? {} : { bodyFont: text(d["bodyFont"])! }),
    ...(typeof d["radius"] === "number" && Number.isFinite(d["radius"]) ? { radius: d["radius"] } : {}),
    ...(Object.keys(pictureKeys).length === 0 ? {} : { picture: pictureKeys }),
    ...(text(d["logoPlacement"]) === undefined ? {} : { logoPlacement: text(d["logoPlacement"])! }),
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** #554: how many rules a project keeps, and how long one may be — both bound the prompt section. */
export const MEMORY_LIMIT = 30;
export const MEMORY_MAX_CHARS = 300;

export const createPostgresProjectService = (deps: ProjectDeps): ProjectService => {
  const { sql } = deps;
  const service: ProjectService = {
  async current(context: ExecutionContext): Promise<ActiveProject | null> {
    if (context.conversationId === undefined) return null;
    const rows = await sql.query<Row>(
      `select p.id, p.name, p.instructions, p.defaults, p.avatar, p.design
         from public.project_conversations pc
         join public.projects p on p.id = pc.project_id and p.workspace_id = pc.workspace_id
        where pc.workspace_id = $1::uuid
          and pc.conversation_id = $2
          and (p.owner_id is null or p.owner_id::text = $3)`,
      [String(context.tenantId), String(context.conversationId).toLowerCase(), String(context.principalId)],
    );
    const row = rows[0];
    if (row === undefined) return null;
    // #554: what the project's chats taught, newest first. A missing table (a deployment not migrated) reads as none.
    const memories = await sql
      .query<{ id: string; text: string }>(
        `select id, text from public.project_memories where project_id = $1::uuid and workspace_id = $2::uuid order by created_at desc limit $3`,
        [row.id, String(context.tenantId), MEMORY_LIMIT],
      )
      .catch(() => [] as { id: string; text: string }[]);
    const defaults = row.defaults ?? {};
    const channels = Array.isArray(defaults["channels"]) ? (defaults["channels"] as unknown[]).filter((c): c is string => typeof c === "string") : undefined;
    const hashtags = text(defaults["hashtags"]);
    const cta = text(defaults["cta"]);
    const a = row.avatar ?? {};
    const avatar = {
      ...(text(a["name"]) === undefined ? {} : { name: text(a["name"])! }),
      ...(text(a["persona"]) === undefined ? {} : { persona: text(a["persona"])! }),
      ...(text(a["look"]) === undefined ? {} : { look: text(a["look"])! }),
      ...(Array.isArray(a["referenceAssetIds"]) && (a["referenceAssetIds"] as unknown[]).length > 0
        ? { referenceCount: (a["referenceAssetIds"] as unknown[]).length }
        : {}),
    };
    const d = row.design ?? {};
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
    const colors = strings(d["colors"]);
    const ratios = strings(d["aspectRatios"]);
    const design = {
      ...(colors.length === 0 ? {} : { colors }),
      ...(text(d["fonts"]) === undefined ? {} : { fonts: text(d["fonts"])! }),
      ...(text(d["imageStyle"]) === undefined ? {} : { imageStyle: text(d["imageStyle"])! }),
      ...(ratios.length === 0 ? {} : { aspectRatios: ratios }),
      ...(text(d["facebookBackground"]) === undefined ? {} : { facebookBackground: text(d["facebookBackground"])! }),
      ...(text(d["logoAssetId"]) === undefined ? {} : { hasLogo: true }),
      ...themeKeys(d),
    };
    return {
      id: row.id,
      name: row.name,
      instructions: row.instructions ?? "",
      defaults: {
        ...(channels === undefined || channels.length === 0 ? {} : { channels }),
        ...(hashtags === undefined ? {} : { hashtags }),
        ...(cta === undefined ? {} : { cta }),
      },
      ...(Object.keys(avatar).length === 0 ? {} : { avatar }),
      ...(Object.keys(design).length === 0 ? {} : { design }),
      ...(memories.length === 0 ? {} : { memories }),
    };
  },

  async logoReference(context) {
    if (context.conversationId === undefined) return undefined;
    /*
     * #615: the logo the kit names, as a stored path — the project's own file (an upload, or a generation kept
     * in the project), scoped exactly as `current` is. Only an image in the workspace's own folder; the reader
     * checks the prefix again before anything is signed.
     */
    const rows = await sql
      .query<{ path: string | null }>(
        `select coalesce(pa.storage_path, ga.storage_path) as path
           from public.project_conversations pc
           join public.projects p on p.id = pc.project_id and p.workspace_id = pc.workspace_id
           join public.project_assets pa on pa.id::text = p.design->>'logoAssetId' and pa.project_id = p.id and pa.workspace_id = p.workspace_id
           left join public.generated_assets ga on ga.id = pa.generated_asset_id and ga.workspace_id = pa.workspace_id
          where pc.workspace_id = $1::uuid
            and pc.conversation_id = $2
            and (p.owner_id is null or p.owner_id::text = $3)
            and pa.kind = 'image'`,
        [String(context.tenantId), String(context.conversationId).toLowerCase(), String(context.principalId)],
      )
      .catch(() => [] as { path: string | null }[]);
    const path = rows[0]?.path ?? null;
    if (path === null || !path.startsWith(`${String(context.tenantId)}/`) || path.includes("..") || !/\.(png|jpe?g|webp)$/i.test(path)) return undefined;
    return `chorus-media:${path}`;
  },

  async update(context, patch) {
    const write = deps.updateProject;
    if (write === undefined) {
      throw new AgentPlatformError({ code: "capability_unavailable", message: "This deployment cannot change projects.", retryable: false });
    }
    if ((await service.current(context)) === null) {
      throw new AgentPlatformError({ code: "invalid_input", message: "This conversation is not in a project, so there is nothing to change.", retryable: false });
    }
    return write({ context, patch });
  },

  async remember(context, input) {
    const project = await service.current(context);
    if (project === null) {
      throw new AgentPlatformError({ code: "invalid_input", message: "This conversation is not in a project, so there is nowhere to remember that.", retryable: false });
    }
    const text = input.text.replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > MEMORY_MAX_CHARS) {
      throw new AgentPlatformError({ code: "invalid_input", message: `A rule is 3 to ${MEMORY_MAX_CHARS} characters.`, retryable: false });
    }
    /*
     * The same rule twice is one rule. Compared case- and space-insensitively, because the model restates
     * what it learned and "Never say revolutionary." and "never say revolutionary" are one memory.
     */
    const [existing] = await sql.query<{ id: string }>(
      `select id from public.project_memories
        where project_id = $1::uuid and workspace_id = $2::uuid and lower(regexp_replace(text, '\\s+', ' ', 'g')) = lower($3)
        limit 1`,
      [project.id, String(context.tenantId), text],
    );
    if (existing !== undefined) return { memoryId: existing.id, duplicate: true };
    const [count] = await sql.query<{ n: string }>(
      "select count(*)::text as n from public.project_memories where project_id = $1::uuid and workspace_id = $2::uuid",
      [project.id, String(context.tenantId)],
    );
    if (Number(count?.n ?? "0") >= MEMORY_LIMIT) {
      throw new AgentPlatformError({
        code: "conflict",
        message: `This project already remembers ${MEMORY_LIMIT} rules. Ask the person which one to forget (the project page lists them), or fold this one into its instructions.`,
        retryable: false,
      });
    }
    const [row] = await sql.query<{ id: string }>(
      `insert into public.project_memories (project_id, workspace_id, text, source_conversation_id, created_by)
       values ($1::uuid, $2::uuid, $3, $4, $5::uuid)
       returning id`,
      [project.id, String(context.tenantId), text, context.conversationId === undefined ? null : String(context.conversationId).toLowerCase(), UUID.test(String(context.principalId)) ? String(context.principalId) : null],
    );
    return { memoryId: row!.id, duplicate: false };
  },

  async extractBrandKit(context, input) {
    const read = deps.extractBrandKit;
    if (read === undefined) {
      throw new AgentPlatformError({ code: "capability_unavailable", message: "This deployment cannot read websites for a brand kit.", retryable: false });
    }
    return read({ context, url: input.url });
  },

  async listAssets(context: ExecutionContext): Promise<readonly ProjectAsset[]> {
    const project = await service.current(context);
    if (project === null) return [];
    const rows = await sql.query<{ id: string; kind: ProjectAsset["kind"]; label: string; url: string | null }>(
      `select id, kind, label, url from public.project_assets
        where project_id = $1::uuid and workspace_id = $2::uuid
        order by created_at`,
      [project.id, String(context.tenantId)],
    );
    // A link's page is safe to name; a file's storage location is not, and is never returned.
    return rows.map((row) => ({ id: row.id, kind: row.kind, label: row.label, ...(row.kind === "link" && row.url !== null ? { url: row.url } : {}) }));
  },

  async renderTemplate(context, input) {
    const render = deps.renderTemplate;
    if (render === undefined) {
      throw new AgentPlatformError({ code: "capability_unavailable", message: "This deployment cannot render templates.", retryable: false });
    }
    // The app finds the project from the conversation itself; asking here first gives the clear answer outside one.
    if ((await service.current(context)) === null) {
      throw new AgentPlatformError({ code: "invalid_input", message: "This conversation is not in a project, so there is no style kit to render with.", retryable: false });
    }
    return render({ context, ...input });
  },

  async attachAsset(context, input) {
    const attach = deps.attachPaths;
    if (attach === undefined) {
      throw new AgentPlatformError({ code: "capability_unavailable", message: "This deployment cannot attach project files.", retryable: false });
    }
    if (!UUID.test(input.projectAssetId)) {
      throw new AgentPlatformError({ code: "invalid_input", message: "projectAssetId must be one of list_project_assets' ids.", retryable: false });
    }
    const project = await service.current(context);
    if (project === null) {
      throw new AgentPlatformError({ code: "invalid_input", message: "This conversation is not in a project, so it has no project files.", retryable: false });
    }
    const [row] = await sql.query<{ kind: string; storage_path: string | null; asset_path: string | null }>(
      `select pa.kind, pa.storage_path, ga.storage_path as asset_path
         from public.project_assets pa
         left join public.generated_assets ga on ga.id = pa.generated_asset_id and ga.workspace_id = pa.workspace_id
        where pa.id = $1::uuid and pa.project_id = $2::uuid and pa.workspace_id = $3::uuid`,
      [input.projectAssetId, project.id, String(context.tenantId)],
    );
    if (row === undefined) {
      throw new AgentPlatformError({ code: "not_found", message: "That file is not in this conversation's project.", retryable: false });
    }
    const path = row.storage_path ?? row.asset_path;
    if (row.kind === "link" || path === null) {
      throw new AgentPlatformError({ code: "invalid_input", message: "A link cannot be attached to a post; put it in the caption instead.", retryable: false });
    }
    const result = await attach(context, { draftId: input.postDraftId, paths: [path] });
    return { postDraftId: String(result.draftId), attached: result.mediaAssetIds.length };
  },
  };
  return service;
};
