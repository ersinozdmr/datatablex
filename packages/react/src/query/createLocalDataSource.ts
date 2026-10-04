import type { DataSource, DataTableQuery, DataTableResult, QueryableColumn } from "@datatablex/core";
import { queryInMemory } from "@datatablex/core";

/**
 * Adapts `queryInMemory` to the `DataSource<T>` interface. The filtering,
 * sorting and pagination logic over an in-memory `T[]` array is defined in a
 * single place (`@datatablex/core`).
 *
 * @param data The records to query.
 * @param columns Optional column definitions that give the field, accessor, type and searchability of each column.
 *
 * @example
 * ```ts
 * const dataSource = createLocalDataSource(users, columns);
 *
 * const table = useDataTable({ columns, dataSource });
 * ```
 */
export function createLocalDataSource<T>(data: T[], columns?: QueryableColumn<T>[]): DataSource<T> {
  return {
    fetch(query: DataTableQuery): Promise<DataTableResult<T>> {
      return Promise.resolve(queryInMemory(data, query, columns));
    },
  };
}
