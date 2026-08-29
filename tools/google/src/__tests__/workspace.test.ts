/**
 * Drive, Docs and Sheets — REQ-054 (#232), task #235.
 *
 * Three of these guard acts with no recovery path:
 *
 * - **AC-3/AC-5** `sheets_update_values` overwrites cells that nothing can restore, and `sheets_append_rows`
 *   must genuinely append. An append implemented as an update at a guessed range looks identical until the day
 *   the guess is one row short.
 * - **AC-4** `drive_share_file` with `anyone` publishes a file to whoever has the link, and a link cannot be
 *   un-copied.
 * - **AC-7** the whole-Drive scope is never asked for. Scope creep in a constant is a one-word change.
 */
import { describe, expect, it, vi } from "vitest";
import { bearer, type CredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import {
  createGoogleToolkit,
  DRIVE_FILE,
  DRIVE_FULL,
  GOOGLE_SCOPES,
  isValidA1,
  NEVER_REQUESTED,
  parseA1,
  splitSheet,
} from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const textResponse = (body: string): Response => new Response(body, { status: 200 });

const ALL_SCOPES = GOOGLE_SCOPES.map((entry) => entry.scope).join(" ");
const resolver: CredentialResolver = { async resolve() { return bearer("ya29.token", { scope: ALL_SCOPES }); } };

const run = async (name: string, fetchImpl: typeof fetch, input: unknown) => {
  const tools = await createGoogleToolkit({ credentialRef: "google", resolver, fetchImpl }).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

const calls = (fetchImpl: typeof fetch) =>
  (fetchImpl as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls;

describe("scopes stay narrow — AC-7", () => {
  it("no tool asks for the whole-Drive scope", async () => {
    /**
     * `drive` is read-write over a user's entire Drive; `drive.file` reaches only files this app created or the
     * user picked. Every write here works under the narrow one, and the difference is invisible on a consent
     * screen at a glance — which is why the absence is asserted rather than trusted.
     */
    const tools = await createGoogleToolkit({ credentialRef: "google", resolver, fetchImpl: vi.fn() as unknown as typeof fetch }).listTools(context);
    for (const tool of tools) {
      expect(tool.descriptor.requiredScopes ?? [], tool.descriptor.name).not.toContain(DRIVE_FULL);
    }
    expect(NEVER_REQUESTED).toContain(DRIVE_FULL);
    // And it is not smuggled in through the published scope table either.
    expect(GOOGLE_SCOPES.map((entry) => entry.scope)).not.toContain(DRIVE_FULL);
  });

  it("uses drive.file for every Drive write", async () => {
    const tools = await createGoogleToolkit({ credentialRef: "google", resolver, fetchImpl: vi.fn() as unknown as typeof fetch }).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    for (const write of ["drive_create_folder", "drive_upload_file", "drive_move_file", "drive_share_file"]) {
      expect(byName.get(write)?.requiredScopes, write).toEqual([DRIVE_FILE]);
    }
  });
});

describe("A1 ranges are checked before they are sent — AC-6", () => {
  it("accepts the forms that mean what they look like", () => {
    expect(parseA1("A1")).toMatchObject({ start: "A1", openEnded: false });
    expect(parseA1("A1:C10")).toMatchObject({ start: "A1", end: "C10", openEnded: false });
    expect(parseA1("Sheet1!A1:C10")).toMatchObject({ sheet: "Sheet1", start: "A1", end: "C10" });
    // A whole column, written unambiguously with both ends the same kind.
    expect(parseA1("A:C")).toMatchObject({ openEnded: true });
  });

  it("handles a quoted sheet name containing an exclamation mark", () => {
    // Splitting on the first `!` is wrong for exactly the names most likely to appear in a real spreadsheet.
    expect(splitSheet("'Q1 Budget!Draft'!A1:C10")).toEqual({ sheet: "Q1 Budget!Draft", range: "A1:C10" });
    expect(splitSheet("'It''s Mine'!A1")).toEqual({ sheet: "It's Mine", range: "A1" });
  });

  it("refuses a range that mixes a cell and a column", () => {
    /**
     * `A1:C` is legal to Google and means every row of three columns. A caller who meant `A1:C1` has just
     * addressed the whole column — and for `sheets_update_values` that is the difference between three cells
     * and a spreadsheet.
     */
    expect(() => parseA1("A1:C")).toThrow(/mixes a cell and a column/);
    expect(() => parseA1("A:C10")).toThrow(/mixes a column and a cell/);
  });

  it("refuses the malformed shapes with a message that says what is wrong", () => {
    expect(() => parseA1("")).toThrow(/required/);
    expect(() => parseA1("A1:C10:E20")).toThrow(/more than one colon/);
    expect(() => parseA1("1A")).toThrow(/not a cell reference/);
    expect(isValidA1("A1:C1O")).toBe(false); // letter O, not zero
  });

  it("reads a bare sheet reference as the whole sheet, which is open-ended", () => {
    // `Sheet1!` with nothing after it means the whole tab, as it does to Google. Marking it open-ended is what
    // makes `sheets_update_values` refuse it — the safe direction for an ambiguous input.
    expect(parseA1("Sheet1!")).toMatchObject({ sheet: "Sheet1", openEnded: true });
    // A bare name with no `!` is genuinely ambiguous with a cell reference, and is refused rather than guessed.
    expect(() => parseA1("Sheet1")).toThrow(/not a cell reference/);
  });

  it("refuses locally rather than sending", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("sheets_get_values", fetchImpl, { spreadsheetId: "s1", range: "A1:C1O" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("not a cell reference");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the append genuinely appends — AC-5", () => {
  it("uses Google's append endpoint, not an update at a guessed range", async () => {
    /**
     * The defect AC-5 names. Reading the sheet, computing the last row and writing there is wrong twice: the
     * sheet can change in between, and a guess one row short overwrites the last row of real data. Both look
     * exactly like a working append until they do not.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ updates: { updatedRange: "Sheet1!A4:B5", updatedRows: 2, updatedCells: 4 } }),
    ) as unknown as typeof fetch;
    const result = (await run("sheets_append_rows", fetchImpl, {
      spreadsheetId: "s1",
      range: "Sheet1!A1",
      rows: [["a", 1], ["b", 2]],
    })) as { data: { updatedRange: string; rowsAdded: number } };

    const [url, init] = calls(fetchImpl)[0] ?? [];
    expect(String(url)).toContain(":append");
    expect(String(url)).not.toContain(":update");
    expect(init?.method).toBe("POST");
    // The range Google *wrote to*, not the one asked for — and the difference is the point of an append.
    expect(result.data.updatedRange).toBe("Sheet1!A4:B5");
    expect(result.data.rowsAdded).toBe(2);
  });

  it("inserts rows rather than overwriting empty ones below the data", async () => {
    // Google's default `OVERWRITE` writes into existing blank rows below the data, which is occasionally
    // somebody's carefully placed footer. Inserting cannot surprise anyone.
    const fetchImpl = vi.fn(async () => jsonResponse({ updates: {} })) as unknown as typeof fetch;
    await run("sheets_append_rows", fetchImpl, { spreadsheetId: "s1", range: "A1", rows: [["x"]] });
    expect(String(calls(fetchImpl)[0]?.[0])).toContain("insertDataOption=INSERT_ROWS");
  });

  it("never issues a read before appending, so nothing can change in between", async () => {
    // A read-then-write append has a race by construction. Asserting there is exactly one call is the simplest
    // way to prove this one does not have it.
    const fetchImpl = vi.fn(async () => jsonResponse({ updates: {} })) as unknown as typeof fetch;
    await run("sheets_append_rows", fetchImpl, { spreadsheetId: "s1", range: "A1", rows: [["x"]] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an append with no rows", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("sheets_append_rows", fetchImpl, { spreadsheetId: "s1", range: "A1", rows: [] })) as {
      ok: false;
    };
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("overwriting is classified as destruction — AC-3", () => {
  it("is destroys(), not confirms()", async () => {
    /**
     * The only write in the catalogue that destroys data no delete tool touched. `confirms()` would place it in
     * the same class as an append, and those are not the same act — a vocabulary that cannot tell them apart
     * tells an operator nothing.
     */
    const tools = await createGoogleToolkit({ credentialRef: "google", resolver, fetchImpl: vi.fn() as unknown as typeof fetch }).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    expect(byName.get("sheets_update_values")).toMatchObject({
      effect: "destructive",
      approvalPolicy: "always",
      requiresIdempotencyKey: true,
    });
    // Beside the append, which is the comparison that makes the classification mean something.
    expect(byName.get("sheets_append_rows")?.effect).toBe("external-write");
  });

  it("says in its description and its result that there is no recovery", async () => {
    const tools = await createGoogleToolkit({ credentialRef: "google", resolver, fetchImpl: vi.fn() as unknown as typeof fetch }).listTools(context);
    const descriptor = tools.find((t) => t.descriptor.name === "sheets_update_values")?.descriptor;
    expect(descriptor?.description).toMatch(/cannot be undone/i);
    expect(descriptor?.description).toContain("sheets_append_rows");

    const fetchImpl = vi.fn(async () => jsonResponse({ updatedRange: "Sheet1!A1:B2", updatedCells: 4 })) as unknown as typeof fetch;
    const result = (await run("sheets_update_values", fetchImpl, {
      spreadsheetId: "s1",
      range: "Sheet1!A1:B2",
      rows: [["a", "b"], ["c", "d"]],
    })) as { data: { recoverable: boolean } };
    // In the result too, so a summary of what happened cannot soften it.
    expect(result.data.recoverable).toBe(false);
  });

  it("refuses an open-ended range, which would overwrite the whole sheet", async () => {
    /**
     * `Sheet1!A:C` is a legal range meaning every row of three columns. Reading it is harmless; overwriting it
     * replaces a spreadsheet's worth of cells from three rows of input. This is the one place the same input
     * means something catastrophic, so it is the one place it is refused.
     */
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("sheets_update_values", fetchImpl, {
      spreadsheetId: "s1",
      range: "Sheet1!A:C",
      rows: [["x", "y", "z"]],
    })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("every row");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still allows the same open-ended range for a read", async () => {
    // Without this, the refusal above would look like "open-ended ranges are broken" rather than "overwriting
    // one is".
    const fetchImpl = vi.fn(async () => jsonResponse({ range: "Sheet1!A:C", values: [["a"]] })) as unknown as typeof fetch;
    const result = (await run("sheets_get_values", fetchImpl, { spreadsheetId: "s1", range: "Sheet1!A:C" })) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

describe("sharing cannot go public by omission — AC-4", () => {
  it("refuses when no audience was stated", async () => {
    /**
     * The sabotage this AC asks for. A model that meant "share with Ana" omits the field, a default fills in
     * `anyone`, and a document is on the open internet — with the API returning success either way.
     */
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("drive_share_file", fetchImpl, { id: "f1", email: "ana@example.com" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("explicit audience");
    expect(result.error.message).toContain("must never be the one that happens by omission");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is gated at least as strongly as a named share, and says what it exposes", async () => {
    const tools = await createGoogleToolkit({ credentialRef: "google", resolver, fetchImpl: vi.fn() as unknown as typeof fetch }).listTools(context);
    const descriptor = tools.find((t) => t.descriptor.name === "drive_share_file")?.descriptor;
    // One tool, so the permissive and the named case are gated identically by construction — there is no path
    // where `anyone` is cheaper than `user`.
    expect(descriptor).toMatchObject({ effect: "external-write", approvalPolicy: "always" });
    expect(descriptor?.description).toContain("everybody who has the link");
    expect(descriptor?.description).toContain("cannot be un-shared");
  });

  it("reports publicly-accessible in the result when it was", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "p1", type: "anyone", role: "reader" })) as unknown as typeof fetch;
    const result = (await run("drive_share_file", fetchImpl, { id: "f1", audience: "anyone" })) as {
      data: { publiclyAccessible: boolean; warning: string };
    };
    expect(result.data.publiclyAccessible).toBe(true);
    expect(result.data.warning).toContain("Anyone with the link");
  });

  it("does not claim public access for a named share", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "p1", type: "user", role: "reader" })) as unknown as typeof fetch;
    const result = (await run("drive_share_file", fetchImpl, { id: "f1", audience: "user", email: "ana@example.com" })) as {
      data: { publiclyAccessible: boolean };
    };
    expect(result.data.publiclyAccessible).toBe(false);
  });

  it("needs the address or domain the audience implies", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(((await run("drive_share_file", fetchImpl, { id: "f", audience: "user" })) as { ok: boolean }).ok).toBe(false);
    expect(((await run("drive_share_file", fetchImpl, { id: "f", audience: "domain" })) as { ok: boolean }).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("defaults the role to reader rather than writer", async () => {
    // The defaulted argument that *is* allowed, defaulted to the least powerful value.
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "p1" })) as unknown as typeof fetch;
    await run("drive_share_file", fetchImpl, { id: "f1", audience: "user", email: "ana@example.com" });
    expect(JSON.parse(calls(fetchImpl)[0]?.[1]?.body ?? "{}").role).toBe("reader");
  });
});

describe("native types export, binary ones say they cannot — AC-2", () => {
  const fileOf = (mimeType: string, exported = "content") =>
    vi.fn(async (url: unknown) =>
      String(url).includes("/export") || String(url).includes("alt=media")
        ? textResponse(exported)
        : jsonResponse({ id: "f1", name: "A file", mimeType, webViewLink: "https://drive/x" }),
    ) as unknown as typeof fetch;

  it("exports a Doc to markdown", async () => {
    const fetchImpl = fileOf("application/vnd.google-apps.document", "# Title\n\nBody");
    const result = (await run("drive_get_file", fetchImpl, { id: "f1" })) as {
      data: { content: string; exportedAs: string };
    };
    expect(result.data.content).toContain("# Title");
    expect(result.data.exportedAs).toBe("markdown");
    expect(String(calls(fetchImpl)[1]?.[0])).toContain("text%2Fmarkdown");
  });

  it("exports a Sheet to CSV and says only the first sheet came back", async () => {
    const fetchImpl = fileOf("application/vnd.google-apps.spreadsheet", "a,b\n1,2");
    const result = (await run("drive_get_file", fetchImpl, { id: "f1" })) as { data: { exportedAs: string } };
    // The caveat matters: a workbook of twelve tabs exports one, and a caller told "CSV" would not know.
    expect(result.data.exportedAs).toContain("first sheet only");
  });

  it("returns metadata and a clear refusal for a binary type, not garbage", async () => {
    /**
     * Decoding a PDF as UTF-8 produces a page of replacement characters that *looks* like content, and a model
     * will try to read it. Saying so is the only honest answer.
     */
    const fetchImpl = fileOf("application/pdf");
    const result = (await run("drive_get_file", fetchImpl, { id: "f1" })) as {
      data: { content: null; readable: boolean; note: string; name: string };
    };
    expect(result.data.content).toBeNull();
    expect(result.data.readable).toBe(false);
    expect(result.data.note).toContain("not text");
    // The metadata is still useful and still there.
    expect(result.data.name).toBe("A file");
    // And nothing was downloaded.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads a plain-text file directly rather than exporting it", async () => {
    const fetchImpl = fileOf("text/plain", "just text");
    const result = (await run("drive_get_file", fetchImpl, { id: "f1" })) as { data: { content: string } };
    expect(result.data.content).toBe("just text");
    expect(String(calls(fetchImpl)[1]?.[0])).toContain("alt=media");
  });

  it("uploads content as raw bytes, not as a JSON string", async () => {
    /**
     * `JSON.stringify` on a string produces a *quoted* string, so the file uploads successfully with its
     * contents wrapped in quotes and escapes. Nothing errors, which is why the transport grew `rawBody`.
     */
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes("/upload/") ? textResponse("") : jsonResponse({ id: "f1", name: "n.txt" }),
    ) as unknown as typeof fetch;
    await run("drive_upload_file", fetchImpl, { name: "n.txt", content: 'a "quoted" line' });
    const upload = calls(fetchImpl).find(([url]) => String(url).includes("/upload/"));
    expect(upload?.[1]?.body).toBe('a "quoted" line');
    expect(upload?.[1]?.body).not.toContain('\\"');
  });

  it("refuses an upload larger than it can handle rather than truncating", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("drive_upload_file", fetchImpl, { name: "big", content: "x".repeat(1_000_001) })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("Split it");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Docs reads structure and appends without a computed index", () => {
  it("turns named heading styles into markdown headings", async () => {
    // Without the named style every heading arrives as a paragraph and the document's structure is gone.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        documentId: "d1",
        title: "Plan",
        body: {
          content: [
            { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Title\n" } }] } },
            { paragraph: { elements: [{ textRun: { content: "Some prose\n" } }] } },
            { paragraph: { bullet: {}, elements: [{ textRun: { content: "a point\n" } }] } },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const result = (await run("docs_get_document", fetchImpl, { id: "d1" })) as { data: { content: string } };
    expect(result.data.content).toBe("# Title\n\nSome prose\n\n- a point");
  });

  it("appends at the end of the segment rather than a computed index", async () => {
    /**
     * The same lesson as the Sheets append: reading the document and inserting at the last index is wrong
     * because the document can change in between, and an off-by-one inserts before the final character.
     */
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    await run("docs_append_text", fetchImpl, { id: "d1", text: "more" });
    const body = JSON.parse(calls(fetchImpl)[0]?.[1]?.body ?? "{}");
    expect(body.requests[0].insertText.endOfSegmentLocation).toEqual({});
    expect(body.requests[0].insertText.location).toBeUndefined();
    // One call: no read to race against.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an append with nothing to append", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(((await run("docs_append_text", fetchImpl, { id: "d1", text: "  " })) as { ok: boolean }).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Drive moves keep the file findable", () => {
  it("removes the old parents it read, rather than guessing", async () => {
    // Drive's move is add-and-remove; removing the wrong parent leaves a file in two places or in none a
    // caller can find.
    const fetchImpl = vi.fn(async (url: unknown, init?: { method?: string }) =>
      (init?.method ?? "GET") === "GET"
        ? jsonResponse({ parents: ["old1", "old2"], name: "f" })
        : jsonResponse({ id: "f1", name: "f", parents: ["new"] }),
    ) as unknown as typeof fetch;
    const result = (await run("drive_move_file", fetchImpl, { id: "f1", toFolderId: "new" })) as {
      data: { movedFrom: string[]; movedTo: string };
    };
    expect(String(calls(fetchImpl)[1]?.[0])).toContain("removeParents=old1%2Cold2");
    expect(result.data.movedFrom).toEqual(["old1", "old2"]);
    expect(result.data.movedTo).toBe("new");
  });
});
