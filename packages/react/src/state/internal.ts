import type { Key } from "react";
import type { UseDataTableOptions } from "../types.js";

/**
 * Resolves the key of a record from the `rowKey` option, which is either a field name or a
 * function (the same contract as the `rowKey` of an Ant Design `Table`).
 */
export function resolveRowKey<T>(record: T, rowKey: UseDataTableOptions<T>["rowKey"]): Key {
  if (typeof rowKey === "function") return rowKey(record);
  return record[rowKey] as Key;
}
