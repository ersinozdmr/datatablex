/**
 * CSV writing rules. The client (`@datatablex/react`) and the server
 * (the `@datatablex/fastify` export route) use the SAME rules, so an export
 * looks the same whichever side produces it.
 */

/** UTF-8 byte order mark placed at the start of a file so that Excel opens non-ASCII characters correctly. */
export const CSV_BOM = "﻿";

/** RFC 4180 line break. */
export const CSV_LINE_BREAK = "\r\n";

/** Plain decimal number literal (`-12.50`, `7`); excludes exponent notation, whitespace and operators. */
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;

/**
 * Formats a single cell: `null`/`undefined` become empty, a `Date` becomes
 * ISO 8601, anything else goes through `String`. Prefixes that a spreadsheet
 * could interpret as a formula (`=`, `+`, `-`, `@`, tab, CR) are turned into
 * literal text with a leading `'` (CWE-1236). The cell is always wrapped in
 * double quotes.
 *
 * The prefix applies to TEXT only. A real `number`/`bigint`/`boolean` (for
 * example `-5`) cannot be a formula and is written as is; otherwise negative
 * numbers would become text, which Excel can neither sum nor sort. PostgreSQL
 * `numeric`/`bigint` columns often come back from the driver as text
 * (`"-12.50"`). When the caller knows the column is numeric it passes
 * `numeric: true`, and text that matches a plain number literal is written
 * without the prefix too. Text that does not look like a number (`-5+3`) is
 * still prefixed, even with `numeric`.
 *
 * @param numeric - Treat text that matches a plain number literal as a number.
 * @default false
 *
 * @example
 * ```ts
 * csvCell('a "b"'); // '"a ""b"""'
 * csvCell(-5); // '"-5"'
 * csvCell("=1+1"); // `"'=1+1"`
 * csvCell("-12.50", true); // '"-12.50"'
 * ```
 */
export function csvCell(value: unknown, numeric = false): string {
  let text: string;
  let literal = false;
  if (value === null || value === undefined) text = "";
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    text = String(value);
    literal = true;
  } else {
    text = String(value);
    literal = numeric && NUMERIC_LITERAL.test(text);
  }
  if (!literal && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Formats one row by joining the formatted cells with `delimiter`. The result
 * does NOT include a line break. When `numericColumns[i]` is `true`, cell `i`
 * is formatted with `csvCell(value, true)` (see `csvCell`).
 *
 * @param delimiter - Separator placed between cells.
 * @default ","
 *
 * @example
 * ```ts
 * csvRow(["a", 1, null]); // '"a","1",""'
 * csvRow(["a", "b"], ";"); // '"a";"b"'
 * csvRow(["-1.5", "-1.5"], ",", [true, false]); // `"-1.5","'-1.5"`
 * ```
 */
export function csvRow(values: readonly unknown[], delimiter = ",", numericColumns?: readonly boolean[]): string {
  return values.map((value, index) => csvCell(value, numericColumns?.[index] === true)).join(delimiter);
}
