import { describe, expect, it } from "vitest";
import type { MessagePart } from "@retinue/react";
import { latestPanelAt, openPanelFor, postActivityIn, postIdFromHref, revisionsOf } from "../postPanel";

/** Which post the Assistant's side panel shows — #497. Parts built the way the runtime emits them. */
const POST = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER = "9b2d1a4e-1111-4222-8333-944455556666";

const call = (id: string, toolName: string, input: unknown) =>
  ({ type: "tool-call", toolCallId: id, toolName, input }) as unknown as MessagePart;
const result = (id: string, toolName: string, output: unknown, ranToolName?: string) =>
  ({ type: "tool-result", toolCallId: id, toolName, output, truncated: false, ...(ranToolName ? { ranToolName } : {}) }) as unknown as MessagePart;
const artifact = (id: string) => ({ type: "artifact", artifactId: id, versionId: `${id}-v1`, title: "Doc" }) as unknown as MessagePart;
const text = (t: string) => ({ type: "text", text: t }) as unknown as MessagePart;

describe("postActivityIn", () => {
  it("opens on the channels being written before the draft exists (AC-1)", () => {
    const parts = [call("c1", "draft_post_for_channels", { brief: "autumn", platformIds: ["instagram", "linkedin"] })];
    expect(postActivityIn(parts)).toEqual({ postId: null, writing: ["instagram", "linkedin"], revision: 0, at: 0 });
  });

  it("binds to the draft the result names, once it is written", () => {
    const parts = [
      call("c1", "draft_post_for_channels", { brief: "autumn", platformIds: ["instagram"] }),
      result("c1", "draft_post_for_channels", { postDraftId: POST, written: [], failed: [] }),
    ];
    expect(postActivityIn(parts)).toMatchObject({ postId: POST, writing: [], revision: 1 });
  });

  it("marks every channel as writing when a revision names none", () => {
    const parts = [call("c2", "revise_post_channels", { postDraftId: POST, instruction: "shorter" })];
    expect(postActivityIn(parts)).toMatchObject({ postId: POST, writing: "all" });
  });

  it("reads the real tool name through execute_tool", () => {
    const parts = [result("c3", "execute_tool", { postDraftId: POST, mediaAssetIds: [] }, "attach_media_to_post")];
    expect(postActivityIn(parts)?.postId).toBe(POST);
  });

  it("ignores a refusal and tools that do not write a post", () => {
    expect(postActivityIn([result("c4", "create_post_draft", { ok: false, error: "nope" })])).toBeNull();
    expect(postActivityIn([result("c5", "list_post_drafts", { postDraftId: POST })])).toBeNull();
    expect(postActivityIn([text("hello")])).toBeNull();
  });
});

describe("openPanelFor", () => {
  it("follows the session: whichever of a post and an artifact came last", () => {
    const postLast = [artifact("a1"), result("c1", "create_post_draft", { postDraftId: POST })];
    expect(openPanelFor(null, postLast)).toEqual({ kind: "post", postId: POST, writing: [] });
    const artifactLast = [result("c1", "create_post_draft", { postDraftId: POST }), artifact("a1")];
    expect(openPanelFor(null, artifactLast)).toEqual({ kind: "artifact", id: "a1" });
  });

  it("keeps the post open when the next message starts a turn with no parts yet — the production bug", () => {
    // Turn 1 wrote the post; turn 2 ("make LinkedIn shorter") has just been sent and has produced nothing.
    const session = [result("c1", "draft_post_for_channels", { postDraftId: POST })];
    expect(openPanelFor(null, session, session.length)).toEqual({ kind: "post", postId: POST, writing: [] });
  });

  it("keeps the reader's choice until something newer happens", () => {
    const parts = [result("c1", "create_post_draft", { postDraftId: POST })];
    const now = latestPanelAt(parts);
    expect(openPanelFor({ kind: "closed", at: now }, parts)).toBeNull();
    expect(openPanelFor({ kind: "artifact", id: "a9", at: now }, parts)).toEqual({ kind: "artifact", id: "a9" });
    expect(openPanelFor({ kind: "post", id: OTHER, at: now }, parts)).toEqual({ kind: "post", postId: OTHER, writing: [] });
  });

  it("opens again for a post written after the reader closed it, and a newer post replaces a chosen one", () => {
    const before = [result("c1", "create_post_draft", { postDraftId: POST })];
    const closedAt = latestPanelAt(before);
    const after = [...before, text("next turn"), result("c2", "create_post_draft", { postDraftId: OTHER })];
    expect(openPanelFor({ kind: "closed", at: closedAt }, after)).toEqual({ kind: "post", postId: OTHER, writing: [] });
    expect(openPanelFor({ kind: "post", id: POST, at: closedAt }, after)).toEqual({ kind: "post", postId: OTHER, writing: [] });
  });

  it("shows Writing… on a chosen post when the live turn is revising it", () => {
    const earlier = [result("c1", "create_post_draft", { postDraftId: POST })];
    const choice = { kind: "post" as const, id: POST, at: latestPanelAt(earlier) };
    const parts = [...earlier, call("c2", "revise_post_channels", { postDraftId: POST, instruction: "x", platformIds: ["linkedin"] })];
    expect(openPanelFor(choice, parts, earlier.length)).toEqual({ kind: "post", postId: POST, writing: ["linkedin"] });
  });

  it("does not show Writing… for a call an earlier turn never finished", () => {
    const interrupted = [call("c2", "revise_post_channels", { postDraftId: POST, instruction: "x" })];
    expect(openPanelFor(null, interrupted, interrupted.length)).toMatchObject({ postId: POST, writing: [] });
  });

  it("opens nothing for a session that made neither", () => {
    expect(openPanelFor(null, [text("hi")])).toBeNull();
    expect(openPanelFor(null, [])).toBeNull();
  });
});

describe("revisionsOf", () => {
  it("counts every result that changed the post, across turns — the panel's reload key", () => {
    const turns = [
      [result("c1", "draft_post_for_channels", { postDraftId: POST })],
      [result("c2", "revise_post_channels", { postDraftId: POST }), result("c3", "create_post_draft", { postDraftId: OTHER })],
    ];
    expect(revisionsOf(POST, turns)).toBe(2);
    expect(revisionsOf(OTHER, turns)).toBe(1);
  });
});

describe("postIdFromHref", () => {
  it("reads a chorus:post token or a bare id, and nothing else", () => {
    expect(postIdFromHref(`chorus:post/${POST}`)).toBe(POST);
    expect(postIdFromHref(POST.toUpperCase())).toBe(POST);
    expect(postIdFromHref("https://example.com")).toBeNull();
  });
});
