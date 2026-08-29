/**
 * Google Workspace tools — REQ-054 (#232), task #234.
 *
 * Gmail and Calendar: the half of Workspace an agent uses to *communicate*, and therefore the half carrying
 * Google's **restricted** scopes and the app-verification burden that comes with them. See the integration
 * page for which scopes those are and what verification means for a deployment.
 *
 * ## What this package assumes, and why it could not have shipped earlier
 *
 * A Google access token lives for an hour. Every tool here therefore assumes #233's refreshable credential:
 * the resolver is asked **per call**, and when the token is expiring it is renewed before the call rather than
 * after a 401. That is why this task was blocked on #233 rather than merely sequenced after it — a toolkit
 * built on a static token would work for exactly one hour per deployment and fail in a way that looks
 * intermittent.
 *
 * ## The scope gate wraps every tool, once
 *
 * Each tool declares `requiredScopes`. The assembly below wraps each one so the declaration is *enforced*
 * rather than documented — a scope named in metadata that nothing checks is the "declared but unread field"
 * defect this repository added a whole check for (#245).
 */

import type { CredentialRef, CredentialResolver, Tool, ToolProvider, ToolkitAuth } from "@retinue/agentkit/tools";

import { calendarTools, CALENDAR_EVENTS, CALENDAR_READONLY } from "./calendar.js";
import { gmailTools, GMAIL_COMPOSE, GMAIL_MODIFY, GMAIL_READONLY, GMAIL_SEND } from "./gmail.js";
import { createGoogleTransport, GOOGLE_API } from "./transport.js";

export { assertHeaderSafe, buildMessage, encodeHeader, htmlToText, bodyOf, headerOf, toBase64Url, fromBase64Url } from "./mime.js";
export type { OutgoingMessage } from "./mime.js";
export { grantedScopes, missingScopes, createGoogleTransport } from "./transport.js";
export type { GoogleTransport } from "./transport.js";
export {
  GMAIL_READONLY,
  GMAIL_SEND,
  GMAIL_COMPOSE,
  GMAIL_MODIFY,
} from "./gmail.js";
export { CALENDAR_READONLY, CALENDAR_EVENTS } from "./calendar.js";

export type GoogleToolkitConfig = {
  /**
   * Resolved per call, by the host. Never read from the environment here.
   *
   * For anything beyond a one-hour session this must be a resolver wrapped in `withRefreshingCredentials`
   * (#233) — a Google access token expires in an hour, and a static one produces a toolkit that stops working
   * mid-afternoon.
   */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Ship only these. Mutually exclusive with `exclude`; an unknown name is refused. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
};

/**
 * Narrow the surface, refusing a name that is not in it.
 *
 * The same rule as `tools-github`'s, and for the same reason: a typo'd `exclude` silently ignored ships the
 * tool an operator believed they had removed. Here it matters more than usual — the tool most likely to be
 * excluded is `gmail_send_message`, and the consequence of a typo is an agent that can send mail.
 */
export const select = (
  all: readonly Tool[],
  config: Pick<GoogleToolkitConfig, "include" | "exclude">,
): readonly Tool[] => {
  if (config.include !== undefined && config.exclude !== undefined) {
    throw new Error(
      "createGoogleToolkit was given both include and exclude. Pick one: include names what ships, exclude names what does not.",
    );
  }
  const known = new Set(all.map((tool) => tool.descriptor.name));
  const requested = config.include ?? config.exclude ?? [];
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `createGoogleToolkit was given ${config.include === undefined ? "exclude" : "include"} names this toolkit ` +
        `does not have: ${unknown.join(", ")}. It has: ${[...known].join(", ")}.`,
    );
  }
  if (config.include !== undefined) {
    const wanted = new Set(config.include);
    return all.filter((tool) => wanted.has(tool.descriptor.name));
  }
  if (config.exclude !== undefined) {
    const unwanted = new Set(config.exclude);
    return all.filter((tool) => !unwanted.has(tool.descriptor.name));
  }
  return all;
};

/**
 * Wraps a tool so its declared scopes are checked before it runs — AC-3, AC-7.
 *
 * The wrapper preserves the descriptor exactly, including `effect` and `approvalPolicy`, so gating is
 * unaffected: a scope check is not an approval and must not look like one to the registry.
 */
const withScopeGate = (tool: Tool, assertScopes: (context: never, name: string, scopes: readonly string[]) => Promise<void>): Tool => {
  const required = tool.descriptor.requiredScopes ?? [];
  if (required.length === 0) return tool;
  return {
    ...tool,
    async execute(request) {
      try {
        await assertScopes(request.context as never, tool.descriptor.name, required);
      } catch (error) {
        // Returned as a failed outcome rather than thrown, matching how `defineTool` reports every other
        // refusal — a thrown error here would reach the model as an internal fault.
        return {
          ok: false,
          error: {
            code: (error as { code?: string }).code ?? "unauthorized",
            message: (error as { message?: string }).message ?? "This tool needs a scope the connection lacks.",
            retryable: false,
          },
        } as Awaited<ReturnType<Tool["execute"]>>;
      }
      return tool.execute(request);
    },
  };
};

export const createGoogleToolkit = (config: GoogleToolkitConfig): ToolProvider => {
  const transport = createGoogleTransport(config);
  const all: readonly Tool[] = [...gmailTools(transport), ...calendarTools(transport)].map((tool) =>
    withScopeGate(tool, (context, name, scopes) => transport.assertScopes(context, name, scopes)),
  );
  const tools = select(all, config);

  return {
    id: "google",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What Google accepts — #260 AC-2.
 *
 * **OAuth only.** Google has no personal-access-token equivalent for Gmail or Calendar: every path is a
 * consented grant, which is why `modes` has one entry where GitHub's has two. The wire format is a bearer, and
 * that is the whole reason `schemes` and `modes` are separate axes.
 */
export const GOOGLE_AUTH: ToolkitAuth = { modes: ["oauth2"], schemes: ["bearer"] };

/**
 * Every scope this toolkit can need, and whether Google calls it **restricted**.
 *
 * Restricted scopes require the operator's Google Cloud app to pass verification — a security assessment that
 * takes weeks and may require a third-party audit — before anyone outside the test users list can consent. A
 * deployment that enables `gmail_search_messages` has signed up for that; one that enables only Calendar has
 * not. Exported so a host can tell an operator which of the two they are in before they find out from a
 * consent screen.
 */
export const GOOGLE_SCOPES: readonly { readonly scope: string; readonly restricted: boolean; readonly why: string }[] = [
  { scope: GMAIL_READONLY, restricted: true, why: "reads the whole mailbox" },
  { scope: GMAIL_SEND, restricted: true, why: "sends mail as the user" },
  { scope: GMAIL_COMPOSE, restricted: true, why: "creates drafts in the mailbox" },
  { scope: GMAIL_MODIFY, restricted: true, why: "changes labels, archives, marks read" },
  // Calendar's are "sensitive" rather than "restricted": verification is required, the security assessment is
  // not. That is a materially smaller burden and worth distinguishing.
  { scope: CALENDAR_READONLY, restricted: false, why: "reads calendars the account can see" },
  { scope: CALENDAR_EVENTS, restricted: false, why: "creates, changes and cancels events, notifying attendees" },
];

export const GOOGLE_TOOL_NAMES = [
  // Gmail.
  "gmail_search_messages",
  "gmail_get_message",
  "gmail_get_thread",
  "gmail_list_labels",
  "gmail_send_message",
  "gmail_reply_message",
  "gmail_create_draft",
  "gmail_modify_labels",
  // Calendar.
  "calendar_list_events",
  "calendar_get_event",
  "calendar_find_free_time",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
] as const;

export { GOOGLE_API };
