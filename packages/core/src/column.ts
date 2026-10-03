import type { DataTableColumn } from "./types.js";

// A column's roles are resolved in one place: `key` is the identity; the
// backend field and the value access are read through the two helpers below.
// Using `column.key` directly as a field or a value in code would tie the
// roles back together.

/**
 * The backend field of a column: `field` if given (including `null`),
 * otherwise `key`. `null` means no filtering or sorting.
 *
 * @example
 * ```ts
 * columnField({ key: "code" }); // "code"
 * columnField({ key: "codeColumn", field: "code" }); // "code"
 * columnField({ key: "fullName", field: null }); // null
 * ```
 */
export function columnField(column: Pick<DataTableColumn<never>, "key" | "field">): string | null {
  return column.field === undefined ? column.key : column.field;
}

/**
 * The raw value that is displayed or exported: `accessor` (a field name or a
 * function), otherwise `record[field ?? key]`.
 *
 * @example
 * ```ts
 * const row = { id: 1, first: "Ada", last: "Smith" };
 * columnValue({ key: "id" }, row); // 1
 * columnValue({ key: "x", accessor: (r: typeof row) => `${r.first} ${r.last}` }, row); // "Ada Smith"
 * ```
 */
export function columnValue<T>(column: Pick<DataTableColumn<T>, "key" | "field" | "accessor">, record: T): unknown {
  const { accessor } = column;
  if (typeof accessor === "function") return accessor(record);
  const name = accessor ?? columnField(column as Pick<DataTableColumn<never>, "key" | "field">) ?? column.key;
  return (record as Record<string, unknown>)[name];
}
