/**
 * The six browser tools — REQ-055 (#237), task #239.
 *
 * ## The escalation has to be visible to a model — AC-7
 *
 * A browser is the more capable-sounding tool, so a model reaches for it first unless the descriptions say
 * otherwise. Every description here therefore begins by naming the cheaper tool and the condition under which
 * this one is warranted. That is not politeness: a browser costs a process, memory and seconds where a fetch
 * costs a request, and defaulting to it turns every page read into a container launch.
 *
 * A test asserts the ordering with `find_tools` rather than trusting the wording — a query about reading a
 * page must rank `web_scrape` above anything here.
 *
 * ## Why the interaction tools are `internal-write`
 *
 * The issue calls this asymmetry uncomfortable and it is. A click changes state on somebody else's server, so
 * it is not a `read`. But this package cannot know *what* the click does — the same button is "expand section"
 * on one page and "delete account" on another — so calling it `external-write` would claim a certainty nobody
 * has, and would gate expanding an accordion behind the same approval as sending money.
 *
 * `internal-write` is the honest label: *this changed something, and we cannot tell you what.* The controls
 * that make it acceptable are elsewhere and are real — a click needs a reference from a read the model just
 * did, the session is time- and memory-capped, no credential is ever typed, and the whole capability is
 * off unless an operator wired a driver.
 */

import { defineTool, type Tool } from "@retinue/agentkit/tools";
import { refuseUrl, resolvePublicly, type Resolve } from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";
import { encloseUntrusted, makeNonce } from "@retinue/agentkit/context";
import { randomBytes } from "node:crypto";

import { ElementChangedError, type BrowserDriver } from "./driver.js";
import { ReferenceError_, StaleReferenceError, type ElementHandle, type Snapshot } from "./refs.js";
import { SessionEndedError, TooManySessionsError, type SessionManager } from "./session.js";

const CATEGORY = "web";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_SCREENSHOT_BYTES = 2_000_000;
export const MAX_TYPE_LENGTH = 2_000;

/**
 * Input names this package refuses to accept — AC-6.
 *
 * Not a filter on the *text* — an agent may legitimately type the word "password" into a search box. This is
 * about the tool's **arguments**: there is no `password`, `token` or `apiKey` parameter anywhere here, because
 * a parameter is an invitation. A test scans the source for these names, and a second test proves the
 * behavioural half: typing into a password field is refused whatever the text is.
 */
export const FORBIDDEN_ARGUMENT_NAMES = [
  "password",
  "passphrase",
  "secret",
  "token",
  "apiKey",
  "credential",
  "otp",
  "mfaCode",
] as const;

const nonce = (): string => makeNonce((bytes) => randomBytes(bytes).toString("hex"));

/** Page text, fenced — AC-8, consistent with #238 and the decision in `docs/23`. */
const fenced = (text: string, url: string, title: string): string =>
  text === "" ? "" : encloseUntrusted({ title, body: text, provenance: url, nonce: nonce() });

const refuse = (code: "invalid_input" | "forbidden" | "not_found", message: string): never => {
  throw new AgentPlatformError({ code, message, retryable: false });
};

/** Turns the reference and session errors into refusals a model can act on. */
const asPlatformError = (error: unknown): never => {
  if (error instanceof StaleReferenceError) refuse("invalid_input", error.message);
  if (error instanceof ReferenceError_) refuse("invalid_input", error.message);
  if (error instanceof SessionEndedError) refuse("not_found", error.message);
  if (error instanceof TooManySessionsError) refuse("forbidden", error.message);
  if (error instanceof ElementChangedError) {
    refuse(
      "invalid_input",
      `${error.message} The page changed between reading it and acting on it. Call browser_read and try again ` +
        "with a fresh reference.",
    );
  }
  throw error;
};

const describeElements = (elements: readonly ElementHandle[]) =>
  elements.map((element) => ({
    ref: element.ref,
    role: element.role,
    name: element.name,
    ...(element.type === undefined ? {} : { type: element.type }),
    ...(element.disabled === true ? { disabled: true } : {}),
  }));

export type BrowserToolsConfig = {
  readonly driver: BrowserDriver;
  readonly sessions: SessionManager;
  readonly timeoutMs?: number;
  /** Injectable so the SSRF tests can run without DNS. */
  readonly resolve?: Resolve;
};

export const browserTools = (config: BrowserToolsConfig): readonly Tool[] => {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * The URL check, shared with `tools-scrape` rather than reimplemented — AC-3.
   *
   * `refuseUrl` and `resolvePublicly` are the same functions `safeFetch` uses, out of
   * `@retinue/agentkit/tools`. A second copy is how one of them ends up missing the IPv6-mapped forms.
   */
  const assertPublic = async (url: string): Promise<string> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return refuse("invalid_input", `"${url}" is not a URL.`);
    }
    const refusal = refuseUrl(parsed);
    if (refusal !== null) return refuse("forbidden", refusal);
    await resolvePublicly(parsed.hostname, config.resolve ?? (await import("@retinue/agentkit/tools")).systemResolve);
    return parsed.toString();
  };

  /**
   * Checked **again** after the page settles — AC-3's "including after an in-page redirect".
   *
   * A page can move itself with `location.replace`, a meta refresh or a JavaScript redirect, none of which the
   * pre-navigation check can see. So the URL the browser actually ended on is validated too, and a session
   * that landed somewhere private is closed rather than read.
   */
  const assertLandedPublicly = async (sessionId: string, snapshot: Snapshot): Promise<void> => {
    let parsed: URL;
    try {
      parsed = new URL(snapshot.url);
    } catch {
      return;
    }
    const refusal = refuseUrl(parsed);
    if (refusal !== null) {
      await config.sessions.close(sessionId, "closed");
      refuse(
        "forbidden",
        `That page redirected itself to ${snapshot.url}, which is ${refusal.replace(/^.*? is /, "")} The session ` +
          "was closed and nothing from that page was read.",
      );
    }
    try {
      await resolvePublicly(parsed.hostname, config.resolve ?? (await import("@retinue/agentkit/tools")).systemResolve);
    } catch (error) {
      await config.sessions.close(sessionId, "closed");
      refuse("forbidden", `${(error as Error).message} The session was closed and nothing from that page was read.`);
    }
  };

  /** Enforces the caps before anything acts, and reports a session that a cap has just ended. */
  const sweepThen = async <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const killed = await config.sessions.sweep();
    const mine = killed.find((entry) => entry.id === sessionId);
    if (mine !== undefined) {
      refuse(
        "not_found",
        `Session "${sessionId}" was ended because it exceeded its ${mine.reason === "lifetime" ? "time" : "memory"} ` +
          "limit, and its browser process group was killed. Start a new session with browser_navigate.",
      );
    }
    return work();
  };

  return [
    defineTool({
      name: "browser_navigate",
      label: "Open a page in a browser",
      description:
        "**Try web_scrape first** — it is far cheaper and works for most pages. Use this only when a page needs JavaScript to render, or when you must interact with it. Opens a URL in a real browser and returns the rendered text plus the elements you can click or type into. Sessions expire on their own; close one with browser_close when you are done.",
      category: CATEGORY,
      approvalPolicy: "always",
      execute: async (input: { url: string; sessionId?: string }, _context) => {
        const url = await assertPublic(input.url);
        const sessionId = input.sessionId ?? "default";
        try {
          await config.sessions.sweep();
          const session = config.sessions.open(sessionId);
          const snapshot = await config.driver.open({ sessionId, url, timeoutMs });
          await assertLandedPublicly(sessionId, snapshot);
          session.references.record(snapshot);
          return {
            sessionId,
            url: snapshot.url,
            title: snapshot.title,
            content: fenced(snapshot.text, snapshot.url, snapshot.title),
            elements: describeElements(snapshot.elements),
            // Said out loud, because the alternative is a model discovering it by having a click refused.
            note: "References are only valid until the next interaction. After a click or type, call browser_read before acting again.",
          };
        } catch (error) {
          return asPlatformError(error);
        }
      },
    }),
    defineTool({
      name: "browser_read",
      label: "Re-read the current page",
      description:
        "Read the page as it is now, after an interaction. **Required** after any click or type before you can act again — an interaction can change the page, and references from before it are no longer valid.",
      category: CATEGORY,
      execute: async (input: { sessionId?: string }, _context) => {
        const sessionId = input.sessionId ?? "default";
        return sweepThen(sessionId, async () => {
          try {
            const session = config.sessions.require(sessionId);
            const snapshot = await config.driver.read({ sessionId, timeoutMs });
            await assertLandedPublicly(sessionId, snapshot);
            session.references.record(snapshot);
            return {
              sessionId,
              url: snapshot.url,
              title: snapshot.title,
              content: fenced(snapshot.text, snapshot.url, snapshot.title),
              elements: describeElements(snapshot.elements),
            };
          } catch (error) {
            return asPlatformError(error);
          }
        });
      },
    }),
    defineTool({
      name: "browser_click",
      label: "Click an element",
      description:
        "Click an element by its `ref` from the most recent browser_navigate or browser_read. Coordinates are not accepted — they mean different things at different window sizes. After this, call browser_read before acting again.",
      category: CATEGORY,
      effect: "internal-write",
      approvalPolicy: "policy",
      execute: async (input: { ref: string; sessionId?: string }, _context) => {
        const sessionId = input.sessionId ?? "default";
        return sweepThen(sessionId, async () => {
          try {
            const session = config.sessions.require(sessionId);
            const { handle } = session.references.resolve(input.ref);
            if (handle.disabled === true) {
              refuse("invalid_input", `"${input.ref}" (${handle.name || handle.role}) is disabled and cannot be clicked.`);
            }
            await config.driver.click({
              sessionId,
              ref: input.ref,
              expect: { tag: handle.tag, name: handle.name },
              timeoutMs,
            });
            // Every interaction invalidates the snapshot. See the header of refs.ts for why this is stricter
            // than strictly necessary on purpose.
            session.references.invalidate();
            return {
              sessionId,
              clicked: { ref: input.ref, role: handle.role, name: handle.name },
              note: "The page may have changed. Call browser_read before acting again.",
            };
          } catch (error) {
            return asPlatformError(error);
          }
        });
      },
    }),
    defineTool({
      name: "browser_type",
      label: "Type into a field",
      description:
        "Type text into a field by its `ref`. **Never type credentials** — this tool refuses password fields, and signing in is not something this toolkit does. After this, call browser_read before acting again.",
      category: CATEGORY,
      effect: "internal-write",
      approvalPolicy: "policy",
      execute: async (input: { ref: string; text: string; sessionId?: string }, _context) => {
        const sessionId = input.sessionId ?? "default";
        return sweepThen(sessionId, async () => {
          try {
            const session = config.sessions.require(sessionId);
            const { handle } = session.references.resolve(input.ref);
            /**
             * The password refusal — AC-6, the behavioural half.
             *
             * Refusing the *field* rather than inspecting the text is what makes this checkable: "does this
             * string look like a password" has no reliable answer, and `type="password"` does. An agent
             * driving a login form is not a capability this package grants, and the place to say so is at the
             * only field that can accept one.
             */
            if ((handle.type ?? "").toLowerCase() === "password") {
              refuse(
                "forbidden",
                `"${input.ref}" is a password field. This toolkit does not type credentials into pages — ` +
                  "signing in is not something it does, and no argument will change that. If the page needs a " +
                  "login, a person has to perform it.",
              );
            }
            if (typeof input.text !== "string" || input.text.length === 0) {
              refuse("invalid_input", "browser_type needs some text to type.");
            }
            if (input.text.length > MAX_TYPE_LENGTH) {
              refuse("invalid_input", `browser_type takes at most ${MAX_TYPE_LENGTH} characters.`);
            }
            if (handle.disabled === true) {
              refuse("invalid_input", `"${input.ref}" (${handle.name || handle.role}) is disabled.`);
            }
            await config.driver.type({
              sessionId,
              ref: input.ref,
              expect: { tag: handle.tag, name: handle.name },
              text: input.text,
              timeoutMs,
            });
            session.references.invalidate();
            return {
              sessionId,
              typedInto: { ref: input.ref, role: handle.role, name: handle.name },
              characters: input.text.length,
              note: "The page may have changed. Call browser_read before acting again.",
            };
          } catch (error) {
            return asPlatformError(error);
          }
        });
      },
    }),
    defineTool({
      name: "browser_screenshot",
      label: "Screenshot the page",
      description:
        "Take a screenshot of the current page. Use this only when the layout itself matters — browser_read gives the text far more cheaply, and an image costs many more tokens to look at.",
      category: CATEGORY,
      execute: async (input: { sessionId?: string; maxBytes?: number }, _context) => {
        const sessionId = input.sessionId ?? "default";
        return sweepThen(sessionId, async () => {
          try {
            config.sessions.require(sessionId);
            const maxBytes = Math.min(Math.max(Math.trunc(input.maxBytes ?? MAX_SCREENSHOT_BYTES), 1), MAX_SCREENSHOT_BYTES);
            const shot = await config.driver.screenshot({ sessionId, maxBytes, timeoutMs });
            return { sessionId, imageBase64: shot.base64, bytes: shot.bytes, truncated: shot.truncated };
          } catch (error) {
            return asPlatformError(error);
          }
        });
      },
    }),
    defineTool({
      name: "browser_close",
      label: "Close the browser session",
      description:
        "Close a browser session and free its resources. Sessions also expire on their own, so forgetting this costs time rather than leaking a process — but closing when you are done is the polite thing.",
      category: CATEGORY,
      effect: "internal-write",
      approvalPolicy: "never",
      execute: async (input: { sessionId?: string }, _context) => {
        const sessionId = input.sessionId ?? "default";
        // Through the manager, which tells the driver via its `onClose` hook. Closing the driver here as well
        // would be a second teardown path, and a second path is where the two drift apart.
        await config.sessions.close(sessionId, "closed");
        return { sessionId, closed: true };
      },
    }),
  ];
};
