import type { Key } from "react";
import type { UseDataTableOptions } from "@datatablex/react";

/** Resolves the key of a record. `rowKey` can be a field name or a function, the same contract as the `rowKey` of Ant Design's `Table`. */
export function resolveRowKey<T>(record: T, rowKey: UseDataTableOptions<T>["rowKey"]): Key {
  if (typeof rowKey === "function") return rowKey(record);
  return record[rowKey] as Key;
}
