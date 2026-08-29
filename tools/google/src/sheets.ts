/**
 * Google Sheets — REQ-054 (#232), task #235.
 *
 * ## Why `sheets_update_values` is `destroys()` and not `confirms()` — AC-3
 *
 * This is the only tool in the whole catalogue where a **write** destroys data that no delete tool touched.
 * Writing `A1:C10` over populated cells replaces them; the previous values are not in a trash, not in a
 * revision the API exposes, and not recoverable through anything this package can call. A person can use
 * Sheets' own version history in a browser. An agent cannot, and neither can the runtime.
 *
 * `confirms()` would put it in the same class as `sheets_append_rows`, and those two are not the same act:
 * one adds rows below the data and the other overwrites whatever is there. A vocabulary that cannot tell them
 * apart is a vocabulary that tells an operator nothing.
 *
 * **Reconciled with #228**, as the AC asks. That decision left `ToolEffect` at four values and moved the
 * *publishing* question to an exact list, which does not touch this: `destructive` already means "no recovery
 * path", which is exactly the claim being made here, and the derivation in `define.ts` gives it
 * `approvalPolicy: always` and an idempotency key for free. Nothing about #228 argues for a fifth value here
 * — it argues against inventing one when an existing value already says the true thing.
 *
 * ## Why the append is a real append
 *
 * `sheets_append_rows` uses Google's `values:append`, which finds the end of the data itself. The tempting
 * implementation is `values:update` at a range computed from a prior read — and it is wrong twice over: the
 * sheet can change between the read and the write, and a guessed range that is one row short overwrites the
 * last row of real data. AC-5 exists because that defect looks identical to a working append until the day it
 * is not.
 */

import { confirms, defineTool, destroys, type Tool } from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

import { InvalidRangeError, parseA1 } from "./a1.js";
import type { GoogleTransport } from "./transport.js";

const CATEGORY = "data";

export const SHEETS_READONLY = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const SHEETS_WRITE = "https://www.googleapis.com/auth/spreadsheets";

type Json = Record<string, unknown>;

/** Turns a range error into a platform error, so a caller sees a refusal rather than a crash. */
const checkedRange = (reference: string): string => {
  try {
    parseA1(reference);
    return reference;
  } catch (error) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: error instanceof InvalidRangeError ? error.message : String(error),
      retryable: false,
    });
  }
};

export const sheetsTools = (transport: GoogleTransport): readonly Tool[] => [
  defineTool({
    name: "sheets_list_sheets",
    label: "List a spreadsheet's tabs",
    description:
      "List the tabs in a spreadsheet with their sizes. Read this before addressing a range — a tab name is part of an A1 reference, and guessing it is the most common way a range fails.",
    category: CATEGORY,
    requiredScopes: [SHEETS_READONLY],
    execute: async (input: { spreadsheetId: string }, context) => {
      const book = (await transport.json(
        context,
        `/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}?fields=properties.title,sheets.properties`,
      )) as Json;
      return {
        title: ((book.properties ?? {}) as Json).title,
        sheets: ((book.sheets as Json[] | undefined) ?? []).map((sheet) => {
          const properties = (sheet.properties ?? {}) as Json;
          const grid = (properties.gridProperties ?? {}) as Json;
          return {
            title: properties.title,
            sheetId: properties.sheetId,
            rows: grid.rowCount,
            columns: grid.columnCount,
            hidden: properties.hidden === true,
          };
        }),
      };
    },
  }),
  defineTool({
    name: "sheets_get_values",
    label: "Read a range",
    description:
      "Read cell values from an A1 range, for example `Sheet1!A1:C10`. Returns rows of strings. An empty trailing cell is omitted by Google, so rows can be shorter than the range.",
    category: CATEGORY,
    requiredScopes: [SHEETS_READONLY],
    execute: async (input: { spreadsheetId: string; range: string }, context) => {
      const range = checkedRange(input.range);
      const result = (await transport.json(
        context,
        `/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(range)}`,
      )) as Json;
      const rows = (result.values as unknown[][] | undefined) ?? [];
      return {
        range: result.range,
        rows,
        rowCount: rows.length,
        // Said explicitly because Google omits trailing empties and a caller counting columns will otherwise
        // conclude the sheet is ragged.
        note: rows.length === 0 ? "That range is empty." : "Trailing empty cells are omitted by Google.",
      };
    },
  }),
  confirms({
    name: "sheets_append_rows",
    label: "Add rows to a sheet",
    description:
      "Add rows **below** whatever is already in the sheet. Nothing existing is changed — this is the safe way to write to a spreadsheet. Prefer it to sheets_update_values unless you specifically mean to overwrite. Requires approval.",
    category: CATEGORY,
    requiredScopes: [SHEETS_WRITE],
    execute: async (input: { spreadsheetId: string; range: string; rows: unknown[][] }, context) => {
      if (!Array.isArray(input.rows) || input.rows.length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "sheets_append_rows was called with no rows to add.",
          retryable: false,
        });
      }
      const range = checkedRange(input.range);
      /**
       * Google's own `values:append` — AC-5.
       *
       * `insertDataOption=INSERT_ROWS` rather than the default `OVERWRITE`: the default appends into existing
       * empty rows *below* the data if there are any, which is usually fine and is occasionally somebody's
       * carefully placed footer. Inserting is the option that cannot surprise anyone.
       */
      const result = (await transport.json(
        context,
        `/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(range)}:append` +
          "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
        { method: "POST", body: { values: input.rows } },
      )) as Json;
      const updates = (result.updates ?? {}) as Json;
      return {
        // The range Google actually wrote to, not the one that was asked for — they differ, and the difference
        // is the whole point of an append.
        updatedRange: updates.updatedRange,
        rowsAdded: updates.updatedRows ?? input.rows.length,
        cellsAdded: updates.updatedCells,
      };
    },
  }),
  destroys({
    name: "sheets_update_values",
    label: "Overwrite cells",
    description:
      "Write values into an exact A1 range, **replacing whatever is in those cells**. This cannot be undone through this tool or any other — the previous values are not recoverable except by a person using Sheets' version history in a browser. If the intent is to add data, use sheets_append_rows, which changes nothing existing. Requires approval.",
    category: CATEGORY,
    requiredScopes: [SHEETS_WRITE],
    execute: async (input: { spreadsheetId: string; range: string; rows: unknown[][] }, context) => {
      if (!Array.isArray(input.rows) || input.rows.length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "sheets_update_values was called with no rows to write.",
          retryable: false,
        });
      }
      const parsed = (() => {
        try {
          return parseA1(input.range);
        } catch (error) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: error instanceof InvalidRangeError ? error.message : String(error),
            retryable: false,
          });
        }
      })();
      /**
       * An open-ended range is refused **here specifically**, and nowhere else.
       *
       * `Sheet1!A:C` is a legal range meaning every row of three columns. Reading it is harmless; overwriting
       * it replaces an entire spreadsheet's worth of cells from three rows of input. The rest of this package
       * accepts open-ended ranges because reading one is fine — this is the one place the same input means
       * something catastrophic.
       */
      if (parsed.openEnded) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message:
            `"${input.range}" has no row bound, so it covers every row of those columns — overwriting it ` +
            "would replace the whole sheet. Give an explicit end row, like A1:C10.",
          retryable: false,
        });
      }
      const result = (await transport.json(
        context,
        `/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}` +
          "?valueInputOption=USER_ENTERED",
        { method: "PUT", body: { values: input.rows } },
      )) as Json;
      return {
        updatedRange: result.updatedRange,
        cellsOverwritten: result.updatedCells,
        // Stated in the result as well as the description, so a summary of what happened cannot soften it.
        recoverable: false,
      };
    },
  }),
  confirms({
    name: "sheets_add_sheet",
    label: "Add a tab",
    description: "Add a new tab to a spreadsheet. Nothing existing is changed. Requires approval.",
    category: CATEGORY,
    requiredScopes: [SHEETS_WRITE],
    execute: async (input: { spreadsheetId: string; title: string }, context) => {
      const result = (await transport.json(
        context,
        `/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}:batchUpdate`,
        { method: "POST", body: { requests: [{ addSheet: { properties: { title: input.title } } }] } },
      )) as Json;
      const added = ((((result.replies as Json[] | undefined) ?? [])[0] ?? {}) as Json).addSheet as Json | undefined;
      return { title: input.title, sheetId: ((added?.properties ?? {}) as Json)?.sheetId };
    },
  }),
];
