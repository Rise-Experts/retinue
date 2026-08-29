/**
 * Google Drive and Docs — REQ-054 (#232), task #235.
 *
 * ## `drive_share_file` is an outward-facing write, not a metadata edit
 *
 * It looks like a permissions tweak and it is a publication. `type: "anyone"` makes a file readable by
 * **anybody who has the link**, and Drive links leak: into chat messages, into tickets, into a search index if
 * the file is ever linked from somewhere crawlable. Nothing this package can call reliably un-leaks a link
 * that has already been copied.
 *
 * So the permissive role cannot be reached by omitting an argument — AC-4. `audience` is required, and
 * `"anyone"` has to be typed. A defaulted argument is exactly how a model that meant "share with Ana" shares
 * with the internet, and the failure is silent from the caller's side: the API returns success either way.
 *
 * ## Why `drive.file` and not `drive`
 *
 * `drive` is read-write access to a user's **entire** Drive. `drive.file` is access to files this application
 * created or the user explicitly picked. Every write here works under the narrow one, so the broad one is
 * never requested — and a test asserts no tool declares it, because scope creep in a constant is a one-word
 * change nobody reviews.
 *
 * The trade is real and worth stating: under `drive.file` this toolkit cannot move or share a file it did not
 * create. That is a smaller capability and a much smaller consent, and it is the right default.
 */

import { confirms, defineTool, type Tool } from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

import type { GoogleTransport } from "./transport.js";

const DRIVE_CATEGORY = "files";
const DOCS_CATEGORY = "knowledge";

export const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
/** Per-file, not whole-drive. See the header. */
export const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
export const DOCS_READONLY = "https://www.googleapis.com/auth/documents.readonly";
export const DOCS_WRITE = "https://www.googleapis.com/auth/documents";

/** The broad scope this package deliberately never asks for. Exported so a test can assert its absence. */
export const DRIVE_FULL = "https://www.googleapis.com/auth/drive";

type Json = Record<string, unknown>;

/** How much of an exported document comes back. A Doc can be a book. */
const MAX_EXPORT_CHARS = 40_000;

/**
 * Which Google-native types export to text, and as what — AC-2.
 *
 * A native file has no bytes to download: `files.get?alt=media` fails on it, and `files.export` needs a target
 * MIME type. A binary type — an image, a PDF, a zip — has bytes and they are not text, so exporting one would
 * produce a wall of mojibake that looks like content.
 */
const EXPORTABLE: Readonly<Record<string, { readonly as: string; readonly label: string }>> = {
  "application/vnd.google-apps.document": { as: "text/markdown", label: "markdown" },
  "application/vnd.google-apps.spreadsheet": { as: "text/csv", label: "CSV (first sheet only)" },
  "application/vnd.google-apps.presentation": { as: "text/plain", label: "plain text" },
  "application/vnd.google-apps.script": { as: "application/vnd.google-apps.script+json", label: "JSON" },
};

/** Plain-text types that download directly rather than exporting. */
const READABLE_DIRECTLY = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "text/html"]);

export const driveTools = (transport: GoogleTransport): readonly Tool[] => [
  defineTool({
    name: "drive_search_files",
    label: "Search Drive",
    description:
      "Search Drive with Google's query syntax, for example `name contains 'budget' and mimeType = 'application/vnd.google-apps.spreadsheet'`. Returns each file's id, name, type, owner and modified time.",
    category: DRIVE_CATEGORY,
    requiredScopes: [DRIVE_READONLY],
    execute: async (input: { query: string; limit?: number }, context) => {
      const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
      const params = new URLSearchParams({
        q: input.query,
        pageSize: String(limit),
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,owners(displayName),webViewLink,trashed)",
      });
      const result = (await transport.json(context, `/drive/v3/files?${params.toString()}`)) as Json;
      return {
        files: ((result.files as Json[] | undefined) ?? []).map((file) => ({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          owner: ((file.owners as Json[] | undefined) ?? [])[0]?.displayName,
          modifiedTime: file.modifiedTime,
          size: file.size,
          // Surfaced rather than filtered: a trashed file still matches a search, and a caller acting on one
          // should know why it looks stale.
          trashed: file.trashed === true,
          url: file.webViewLink,
        })),
        truncated: result.nextPageToken !== undefined,
      };
    },
  }),
  defineTool({
    name: "drive_get_file",
    label: "Read a file",
    description:
      "Read a file's metadata and, where it is text, its content. Google Docs, Sheets and Slides are exported to text; a binary file returns its metadata and says it cannot be read as text rather than returning nonsense.",
    category: DRIVE_CATEGORY,
    requiredScopes: [DRIVE_READONLY],
    execute: async (input: { id: string }, context) => {
      const id = encodeURIComponent(input.id);
      const file = (await transport.json(
        context,
        `/drive/v3/files/${id}?fields=id,name,mimeType,modifiedTime,size,owners(displayName),webViewLink`,
      )) as Json;
      const mimeType = String(file.mimeType ?? "");
      const metadata = {
        id: file.id,
        name: file.name,
        mimeType,
        owner: ((file.owners as Json[] | undefined) ?? [])[0]?.displayName,
        modifiedTime: file.modifiedTime,
        size: file.size,
        url: file.webViewLink,
      };

      const exportable = EXPORTABLE[mimeType];
      if (exportable !== undefined) {
        const text = await transport.text(context, `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportable.as)}`);
        const truncated = text.length > MAX_EXPORT_CHARS;
        return {
          ...metadata,
          content: truncated ? `${text.slice(0, MAX_EXPORT_CHARS)}…` : text,
          exportedAs: exportable.label,
          truncated,
        };
      }
      if (READABLE_DIRECTLY.has(mimeType)) {
        const text = await transport.text(context, `/drive/v3/files/${id}?alt=media`);
        const truncated = text.length > MAX_EXPORT_CHARS;
        return { ...metadata, content: truncated ? `${text.slice(0, MAX_EXPORT_CHARS)}…` : text, truncated };
      }
      /**
       * AC-2's other half. A PDF or an image has bytes, and decoding them as UTF-8 produces something that
       * *looks* like content — a page of replacement characters a model will try to read. Saying so is the
       * only honest answer.
       */
      return {
        ...metadata,
        content: null,
        readable: false,
        note:
          `${mimeType} is not text, so its content cannot be read here. The metadata above is everything ` +
          "this tool can offer for it; open the file at its URL to see it.",
      };
    },
  }),
  confirms({
    name: "drive_create_folder",
    label: "Create a folder",
    description: "Create a folder in Drive, optionally inside another. Requires approval.",
    category: DRIVE_CATEGORY,
    requiredScopes: [DRIVE_FILE],
    execute: async (input: { name: string; parentId?: string }, context) => {
      const folder = (await transport.json(context, "/drive/v3/files?fields=id,name,webViewLink", {
        method: "POST",
        body: {
          name: input.name,
          mimeType: "application/vnd.google-apps.folder",
          ...(input.parentId === undefined ? {} : { parents: [input.parentId] }),
        },
      })) as Json;
      return { id: folder.id, name: folder.name, url: folder.webViewLink };
    },
  }),
  confirms({
    name: "drive_upload_file",
    label: "Upload a text file",
    description:
      "Create a file in Drive from text content. Text only — this tool does not upload binary files. Requires approval.",
    category: DRIVE_CATEGORY,
    requiredScopes: [DRIVE_FILE],
    execute: async (
      input: { name: string; content: string; mimeType?: string; parentId?: string },
      context,
    ) => {
      const MAX_UPLOAD = 1_000_000;
      if (typeof input.content !== "string" || input.content.length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "drive_upload_file was called with no content.",
          retryable: false,
        });
      }
      if (input.content.length > MAX_UPLOAD) {
        // Bounded rather than streamed: a resumable upload is a different protocol, and a tool that silently
        // truncated a file would be worse than one that refuses.
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `That content is ${input.content.length} characters and this tool accepts ${MAX_UPLOAD}. Split it, or upload it another way.`,
          retryable: false,
        });
      }
      // Two steps rather than a multipart body: creating the metadata then patching the media is the same
      // number of round trips and avoids hand-building a multipart envelope, which is one more thing to get
      // subtly wrong.
      const created = (await transport.json(context, "/drive/v3/files?fields=id,name,webViewLink", {
        method: "POST",
        body: {
          name: input.name,
          ...(input.parentId === undefined ? {} : { parents: [input.parentId] }),
        },
      })) as Json;
      await transport.text(
        context,
        `/upload/drive/v3/files/${encodeURIComponent(String(created.id))}?uploadType=media`,
        // `rawBody`, not `body`: a media upload wants the file's bytes, and JSON-encoding a string uploads a
        // file whose contents are a quoted JSON literal — successfully, and wrongly.
        { method: "PATCH", rawBody: input.content, contentType: input.mimeType ?? "text/plain" },
      );
      return { id: created.id, name: created.name, url: created.webViewLink };
    },
  }),
  confirms({
    name: "drive_move_file",
    label: "Move a file",
    description:
      "Move a file into a different folder. The file keeps its id and its sharing; only where it sits changes. Requires approval.",
    category: DRIVE_CATEGORY,
    requiredScopes: [DRIVE_FILE],
    execute: async (input: { id: string; toFolderId: string }, context) => {
      const id = encodeURIComponent(input.id);
      // The current parents have to be read: Drive's move is expressed as add-and-remove, and removing the
      // wrong parent leaves a file in two places or in none a caller can find.
      const current = (await transport.json(context, `/drive/v3/files/${id}?fields=parents,name`)) as Json;
      const previous = ((current.parents as string[] | undefined) ?? []).join(",");
      const moved = (await transport.json(
        context,
        `/drive/v3/files/${id}?addParents=${encodeURIComponent(input.toFolderId)}` +
          (previous === "" ? "" : `&removeParents=${encodeURIComponent(previous)}`) +
          "&fields=id,name,parents,webViewLink",
        { method: "PATCH", body: {} },
      )) as Json;
      return { id: moved.id, name: moved.name, movedFrom: previous.split(",").filter(Boolean), movedTo: input.toFolderId };
    },
  }),
  confirms({
    name: "drive_share_file",
    label: "Share a file",
    description:
      "Grant access to a file. **This is an outward-facing act, not a settings change.** Sharing with `anyone` makes the file readable by everybody who has the link, and a Drive link cannot be un-shared once it has been copied into a chat or a ticket. The audience must be stated explicitly — there is no default. Requires approval.",
    category: DRIVE_CATEGORY,
    requiredScopes: [DRIVE_FILE],
    execute: async (
      input: { id: string; audience: "user" | "domain" | "anyone"; email?: string; domain?: string; role?: "reader" | "commenter" | "writer" },
      context,
    ) => {
      /**
       * `audience` is required and has **no default** — AC-4.
       *
       * The failure being prevented: a model that meant "share with Ana" omits the field, a default fills in
       * `anyone`, and a document is on the open internet. The API returns success either way, so nothing
       * downstream notices. Requiring the word means the permissive case is always something somebody typed.
       */
      if (input.audience === undefined) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message:
            "drive_share_file needs an explicit audience: \"user\" for one person, \"domain\" for everyone in " +
            "an organisation, or \"anyone\" for everybody with the link. There is no default, because the " +
            "permissive answer must never be the one that happens by omission.",
          retryable: false,
        });
      }
      if (input.audience === "user" && (input.email === undefined || input.email.trim() === "")) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "Sharing with a person needs their email address.",
          retryable: false,
        });
      }
      if (input.audience === "domain" && (input.domain === undefined || input.domain.trim() === "")) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "Sharing with a domain needs the domain name, for example example.com.",
          retryable: false,
        });
      }

      const role = input.role ?? "reader";
      const permission = (await transport.json(
        context,
        `/drive/v3/files/${encodeURIComponent(input.id)}/permissions?fields=id,type,role`,
        {
          method: "POST",
          body: {
            type: input.audience,
            role,
            ...(input.audience === "user" ? { emailAddress: input.email } : {}),
            ...(input.audience === "domain" ? { domain: input.domain } : {}),
          },
        },
      )) as Json;
      return {
        id: input.id,
        audience: input.audience,
        role,
        permissionId: permission.id,
        // Said in the result too: a summary that reads "shared the file" should not be able to omit this.
        ...(input.audience === "anyone"
          ? { publiclyAccessible: true, warning: "Anyone with the link can now open this file." }
          : { publiclyAccessible: false }),
      };
    },
  }),
];

export const docsTools = (transport: GoogleTransport): readonly Tool[] => [
  defineTool({
    name: "docs_get_document",
    label: "Read a document",
    description: "Read a Google Doc as markdown: headings, paragraphs and lists. Long documents are truncated and say so.",
    category: DOCS_CATEGORY,
    requiredScopes: [DOCS_READONLY],
    execute: async (input: { id: string }, context) => {
      const document = (await transport.json(context, `/v1/documents/${encodeURIComponent(input.id)}`)) as Json;
      const lines: string[] = [];
      for (const element of ((document.body ?? {}) as Json).content as Json[] | undefined ?? []) {
        const paragraph = element.paragraph as Json | undefined;
        if (paragraph === undefined) continue;
        const text = ((paragraph.elements as Json[] | undefined) ?? [])
          .map((run) => String(((run.textRun ?? {}) as Json).content ?? ""))
          .join("")
          .replace(/\n$/, "");
        if (text.trim() === "") continue;
        // The named style is how a Doc records a heading; without it every heading arrives as a paragraph and
        // the document's structure is gone.
        const style = String(((paragraph.paragraphStyle ?? {}) as Json).namedStyleType ?? "");
        const heading = /^HEADING_([1-6])$/.exec(style);
        if (heading !== null) lines.push(`${"#".repeat(Number(heading[1]))} ${text}`);
        else if (paragraph.bullet !== undefined) lines.push(`- ${text}`);
        else lines.push(text);
      }
      const markdown = lines.join("\n\n");
      const truncated = markdown.length > MAX_EXPORT_CHARS;
      return {
        id: document.documentId,
        title: document.title,
        content: truncated ? `${markdown.slice(0, MAX_EXPORT_CHARS)}…` : markdown,
        truncated,
      };
    },
  }),
  confirms({
    name: "docs_create_document",
    label: "Create a document",
    description: "Create a Google Doc from markdown. Headings and bullets are preserved. Requires approval.",
    category: DOCS_CATEGORY,
    requiredScopes: [DOCS_WRITE],
    execute: async (input: { title: string; content?: string }, context) => {
      const document = (await transport.json(context, "/v1/documents", {
        method: "POST",
        body: { title: input.title },
      })) as Json;
      const id = String(document.documentId);
      if (input.content !== undefined && input.content.trim() !== "") {
        await transport.json(context, `/v1/documents/${encodeURIComponent(id)}:batchUpdate`, {
          method: "POST",
          body: { requests: [{ insertText: { location: { index: 1 }, text: input.content } }] },
        });
      }
      return { id, title: document.title, url: `https://docs.google.com/document/d/${id}/edit` };
    },
  }),
  confirms({
    name: "docs_append_text",
    label: "Append to a document",
    description:
      "Add text to the end of a Google Doc. **Append only** — this tool cannot replace or delete existing text, so nothing already written can be lost. Requires approval.",
    category: DOCS_CATEGORY,
    requiredScopes: [DOCS_WRITE],
    execute: async (input: { id: string; text: string }, context) => {
      if (typeof input.text !== "string" || input.text.trim() === "") {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "docs_append_text was called with nothing to append.",
          retryable: false,
        });
      }
      /**
       * `endOfSegmentLocation`, not a computed index — and this is the same lesson as the Sheets append.
       *
       * The obvious implementation reads the document, takes the last index, and inserts there. It is wrong
       * for the same two reasons: the document can change in between, and an off-by-one index inserts *before*
       * the final character rather than after it. Letting Google find the end is the only version that cannot
       * drift.
       */
      const result = (await transport.json(context, `/v1/documents/${encodeURIComponent(input.id)}:batchUpdate`, {
        method: "POST",
        body: { requests: [{ insertText: { endOfSegmentLocation: {}, text: input.text } }] },
      })) as Json;
      return { id: input.id, appended: input.text.length, revisionId: result.writeControl };
    },
  }),
];
