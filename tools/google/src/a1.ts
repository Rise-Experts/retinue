/**
 * A1 notation, parsed and validated — REQ-054 (#232), task #235, AC-6.
 *
 * `Sheet1!A1:C10`. It looks trivial and is the input to the one tool in this catalogue that can destroy data
 * with no recovery path, so it is checked here rather than sent and hoped for.
 *
 * **Why locally rather than letting Google say no.** Sheets answers a malformed range with
 * `400: Unable to parse range: Sheet1!A1:C1O` — a message that is genuinely helpful to a person reading it
 * carefully and useless to a model, which sees a 400 and retries with a different range. Worse, some
 * malformed-looking ranges are *accepted* with a meaning nobody intended: `A1:C` is a valid open-ended range
 * covering every row, and a caller who meant `A1:C1` has just addressed the whole column.
 *
 * So the parser is strict about what it accepts and explicit about what it refuses, and the open-ended forms
 * are accepted only when written unambiguously.
 */

/** The parts of an A1 reference, once it is known to be well formed. */
export type A1Range = {
  /** The tab, when one was named. Absent means the spreadsheet's first visible sheet, which is Google's rule. */
  readonly sheet?: string;
  /** `A1` style, uppercased. Absent for a whole-sheet reference like `Sheet1`. */
  readonly start?: string;
  readonly end?: string;
  /** True when the range has no row bound — `A:C` — and therefore covers every row in those columns. */
  readonly openEnded: boolean;
};

const CELL = /^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}$/;
const COLUMN_ONLY = /^\$?[A-Za-z]{1,3}$/;
const ROW_ONLY = /^\$?[0-9]{1,7}$/;

/**
 * Splits the sheet name from the range, honouring quoting.
 *
 * A sheet named `Q1 Budget!Draft` is written `'Q1 Budget!Draft'!A1`, so splitting on the first `!` is wrong for
 * exactly the names most likely to appear in a real spreadsheet. Quoted names also escape an internal
 * apostrophe by doubling it, which is why this is not a one-line split.
 */
export const splitSheet = (reference: string): { sheet?: string; range: string } => {
  const trimmed = reference.trim();
  if (trimmed.startsWith("'")) {
    // Find the closing quote, skipping doubled ones.
    let index = 1;
    let name = "";
    while (index < trimmed.length) {
      if (trimmed[index] === "'") {
        if (trimmed[index + 1] === "'") {
          name += "'";
          index += 2;
          continue;
        }
        break;
      }
      name += trimmed[index];
      index += 1;
    }
    const rest = trimmed.slice(index + 1);
    if (!rest.startsWith("!")) return { range: trimmed };
    return { sheet: name, range: rest.slice(1) };
  }
  const bang = trimmed.indexOf("!");
  return bang === -1 ? { range: trimmed } : { sheet: trimmed.slice(0, bang), range: trimmed.slice(bang + 1) };
};

export class InvalidRangeError extends Error {}

/**
 * Parses an A1 reference, throwing with an explanation rather than sending something Google will reject.
 *
 * Exported and tested on its own, because it is the guard in front of `sheets_update_values` and a guard that
 * is only exercised through a mocked HTTP call is a guard nobody has really read.
 */
export const parseA1 = (reference: string): A1Range => {
  if (typeof reference !== "string" || reference.trim() === "") {
    throw new InvalidRangeError("A range is required, for example Sheet1!A1:C10.");
  }
  const { sheet, range } = splitSheet(reference);
  if (sheet !== undefined && sheet.trim() === "") {
    throw new InvalidRangeError(`"${reference}" names an empty sheet. Write Sheet1!A1:C10, or just A1:C10.`);
  }

  // A whole-sheet reference: `Sheet1` with no range after the `!`.
  if (range.trim() === "") {
    if (sheet === undefined) {
      throw new InvalidRangeError(`"${reference}" is not a range. Write A1:C10, or Sheet1!A1:C10.`);
    }
    return { sheet, openEnded: true };
  }

  const parts = range.split(":");
  if (parts.length > 2) {
    throw new InvalidRangeError(`"${reference}" has more than one colon. A range is A1:C10, not A1:C10:E20.`);
  }

  const [rawStart, rawEnd] = parts as [string, string | undefined];
  const start = rawStart.trim();
  const end = rawEnd?.trim();

  const shape = (value: string): "cell" | "column" | "row" | "invalid" =>
    CELL.test(value) ? "cell" : COLUMN_ONLY.test(value) ? "column" : ROW_ONLY.test(value) ? "row" : "invalid";

  const startShape = shape(start);
  if (startShape === "invalid") {
    throw new InvalidRangeError(
      `"${start}" is not a cell reference. A cell is a column letter and a row number, like A1 or BC42.`,
    );
  }
  if (end === undefined) {
    if (startShape !== "cell") {
      throw new InvalidRangeError(
        `"${reference}" names a whole ${startShape} without an end. Write ${start}:${start} for one ` +
          `${startShape}, or A1:C10 for a block.`,
      );
    }
    return { ...(sheet === undefined ? {} : { sheet }), start: start.toUpperCase(), openEnded: false };
  }

  const endShape = shape(end);
  if (endShape === "invalid") {
    throw new InvalidRangeError(
      `"${end}" is not a cell reference. A cell is a column letter and a row number, like A1 or BC42.`,
    );
  }
  /**
   * Both ends must be the same shape.
   *
   * `A1:C` is what Google calls an open-ended range and what a caller almost always meant as `A1:C1` — a typo
   * that addresses every row of three columns instead of three cells. Google accepts it silently, which for
   * `sheets_update_values` means overwriting a column instead of a cell. Refusing the mixed form is the whole
   * point of parsing this at all.
   */
  if (startShape !== endShape) {
    throw new InvalidRangeError(
      `"${reference}" mixes a ${startShape} and a ${endShape}. Google reads that as covering every row or ` +
        `column, which is rarely what is meant — write ${start}:${end}1 for cells, or ` +
        `${start}:${end} with both ends the same kind for a whole column or row.`,
    );
  }

  return {
    ...(sheet === undefined ? {} : { sheet }),
    start: start.toUpperCase(),
    end: end.toUpperCase(),
    // A column-only or row-only range has no bound on the other axis.
    openEnded: startShape !== "cell",
  };
};

/** Whether a reference is well formed, for a caller that wants a boolean rather than an exception. */
export const isValidA1 = (reference: string): boolean => {
  try {
    parseA1(reference);
    return true;
  } catch {
    return false;
  }
};
