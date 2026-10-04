/** A cell value that can be written to an export file. */
export type ExportCell = string | number | boolean | Date | null;

/**
 * Reduces a cell value to an `ExportCell` AT RUN TIME. The type system cannot
 * guarantee this: a raw accessor returns `unknown`, a `jsonb` column or a
 * nested object from the API can be an object, and `as ExportCell` only
 * silences the compiler. An object that reaches ExcelJS as `{ formula }`,
 * `{ hyperlink }` or `{ richText }` writes a formula or link cell (CWE-1236,
 * formula injection); this gate turns them into plain text.
 *
 * - `null`/`undefined` become `null`; `string`, `boolean` and a valid `Date` are kept as they are;
 * - a finite `number` is kept, `NaN`/`Infinity` become text;
 * - a `bigint` becomes a `number` if it is a safe integer, otherwise text;
 * - an invalid `Date` becomes `null`;
 * - everything else (object, array, symbol, function) becomes text: JSON for an object or array, `String` for the rest.
 */
export function normalizeExportCell(value: unknown): ExportCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      // A circular structure or a `toJSON` error: it is still not written as an object.
      return String(value);
    }
  }
  return String(value);
}
