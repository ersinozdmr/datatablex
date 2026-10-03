import { columnField, columnValue } from "./column.js";
import type {
  DataTableColumn,
  DataTableQuery,
  DataTableResult,
  Filter,
  FilterGroup,
  QueryableColumn,
  Sort,
} from "./types.js";

type ColumnType = DataTableColumn<unknown>["type"];

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * In SQL, `NULL` is the single notion of "no value"; in JS it has two
 * representations (`null`, and a field that is absent altogether, which reads
 * as `undefined`). The engine must treat both the same way so that local and
 * REST results do not diverge.
 */
function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function toComparable(value: unknown, type: ColumnType): number | string {
  if (type === "date" || type === "datetime" || type === "time") {
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? String(value) : parsed;
  }
  if (type === "number" || type === "currency") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isNaN(n) ? String(value) : n;
  }
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  return String(value ?? "");
}

/**
 * Text comparisons go through `String.prototype` and date comparisons through
 * `Date.parse`. This does NOT guarantee exactly the same semantics as the
 * backend's ILIKE and timezone-aware SQL comparisons.
 */
function compareValues(a: unknown, b: unknown, type: ColumnType): number {
  const ca = toComparable(a, type);
  const cb = toComparable(b, type);
  if (typeof ca === "number" && typeof cb === "number") return ca - cb;
  const sa = String(ca);
  const sb = String(cb);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * The NULL-aware variant of `compareValues`, used for sorting. The PostgreSQL
 * defaults are `ASC → NULLS LAST` and `DESC → NULLS FIRST`; treating null as
 * "greater than everything" yields both with a single rule, because the
 * direction reversal is applied by the caller.
 */
function compareNullable(a: unknown, b: unknown, type: ColumnType): number {
  const aNull = isNullish(a);
  const bNull = isNullish(b);
  if (aNull || bNull) return aNull && bNull ? 0 : aNull ? 1 : -1;
  return compareValues(a, b, type);
}

function evaluateFilter(
  record: Record<string, unknown>,
  filter: Filter,
  columns: Map<string, QueryableColumn<unknown>> | undefined,
): boolean {
  const raw = record[filter.field];
  const type = columns?.get(filter.field)?.type;

  if (filter.operator === "isNull") return isNullish(raw);
  if (filter.operator === "isNotNull") return !isNullish(raw);

  // An empty set is handled BEFORE the NULL early return: the backend
  // `leafExpression` maps an empty `in`/`notIn` to the neutral element
  // (`eb.lit(false)` / `eb.lit(true)`), and that constant expression does NOT
  // look at whether the row is NULL. If the early return below ran first,
  // `notIn: []` would drop NULL rows locally but not over REST. Contract: an
  // empty multi-select filter must NEVER emit a filter leaf at all; `in: []`
  // means "no rows".
  if ((filter.operator === "in" || filter.operator === "notIn") && filter.value.length === 0) {
    return filter.operator === "notIn";
  }

  // Three-valued logic: in SQL EVERY comparison with NULL yields NULL, and
  // WHERE treats that as false, `neq`/`notIn` included. Without this early
  // return, null would fall back to 0 in a numeric column, and a row that does
  // not carry the field at all would fall back to the string "undefined",
  // producing the wrong set of rows.
  if (isNullish(raw)) return false;

  switch (filter.operator) {
    case "eq":
      return compareValues(raw, filter.value, type) === 0;
    case "neq":
      return compareValues(raw, filter.value, type) !== 0;
    case "contains":
      return String(raw ?? "")
        .toLowerCase()
        .includes(String(filter.value).toLowerCase());
    case "startsWith":
      return String(raw ?? "")
        .toLowerCase()
        .startsWith(String(filter.value).toLowerCase());
    case "endsWith":
      return String(raw ?? "")
        .toLowerCase()
        .endsWith(String(filter.value).toLowerCase());
    // NULL rows were already excluded by the early return above, which matches `NOT ILIKE`.
    case "notContains":
      return !String(raw).toLowerCase().includes(String(filter.value).toLowerCase());
    case "notStartsWith":
      return !String(raw).toLowerCase().startsWith(String(filter.value).toLowerCase());
    case "notEndsWith":
      return !String(raw).toLowerCase().endsWith(String(filter.value).toLowerCase());
    case "gt":
      return compareValues(raw, filter.value, type) > 0;
    case "gte":
      return compareValues(raw, filter.value, type) >= 0;
    case "lt":
      return compareValues(raw, filter.value, type) < 0;
    case "lte":
      return compareValues(raw, filter.value, type) <= 0;
    case "between": {
      const [from, to] = filter.value;
      return compareValues(raw, from, type) >= 0 && compareValues(raw, to, type) <= 0;
    }
    case "in":
      return filter.value.some((v) => compareValues(raw, v, type) === 0);
    case "notIn":
      return !filter.value.some((v) => compareValues(raw, v, type) === 0);
  }
}

/**
 * An empty `filters` array yields `true` for AND and `false` for OR, the same
 * semantics as the neutral-element rule of the backend `filterExpression`.
 */
function evaluateGroup(
  record: Record<string, unknown>,
  group: FilterGroup,
  columns: Map<string, QueryableColumn<unknown>> | undefined,
): boolean {
  if (group.filters.length === 0) return group.operator === "AND";
  const results = group.filters.map((child) =>
    "filters" in child
      ? evaluateGroup(record, child, columns)
      : evaluateFilter(record, child, columns),
  );
  return group.operator === "AND" ? results.every(Boolean) : results.some(Boolean);
}

function matchesSearch<T>(
  record: Record<string, unknown>,
  term: string,
  columns: QueryableColumn<T>[] | undefined,
): boolean {
  if (!columns) return false; // an implicit "all string fields" assumption is deliberately not made
  const searchable = columns.filter((c) => c.searchable);
  if (!searchable.length) return false;
  const lowerTerm = term.toLowerCase();
  return searchable.some((c) => {
    const raw = columnValue(c as QueryableColumn<Record<string, unknown>>, record);
    if (isNullish(raw)) return false; // how ILIKE behaves on NULL
    return String(raw).toLowerCase().includes(lowerTerm);
  });
}

function compareBySort(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  sorting: Sort[],
  columns: Map<string, QueryableColumn<unknown>> | undefined,
): number {
  for (const s of sorting) {
    const type = columns?.get(s.field)?.type;
    const cmp = compareNullable(a[s.field], b[s.field], type);
    if (cmp !== 0) return s.direction === "asc" ? cmp : -cmp;
  }
  return 0;
}

/**
 * Runs a {@link DataTableQuery} (filters, search, sorting, pagination) against
 * an in-memory array and returns a {@link DataTableResult}. It is a pure
 * function with no dependencies, so it is the basis of `LocalDataSource` and
 * of unit tests.
 *
 * Without `columns`, search matches no field and comparisons are not
 * type-aware. `page` and `pageSize` are clamped to a minimum of 1, and
 * `pagination.total` is `null` when `skipCount` is set.
 *
 * @example
 * ```ts
 * const result = queryInMemory(
 *   [{ id: 1, age: 30 }, { id: 2, age: 25 }],
 *   {
 *     pagination: { page: 1, pageSize: 10 },
 *     sorting: [{ field: "age", direction: "asc" }],
 *     filters: null,
 *   },
 * );
 * // result.data -> [{ id: 2, age: 25 }, { id: 1, age: 30 }]
 * // result.pagination -> { page: 1, pageSize: 10, total: 2 }
 * ```
 */
export function queryInMemory<T>(
  data: T[],
  query: DataTableQuery,
  columns?: QueryableColumn<T>[],
): DataTableResult<T> {
  const columnsMap = columns
    ? new Map(
        columns.flatMap((c) => {
          // The column TYPE for filtering and sorting is looked up by the backend field (Filter.field/Sort.field).
          const field = columnField(c);
          return field === null ? [] : [[field, c as QueryableColumn<unknown>] as const];
        }),
      )
    : undefined;

  let rows = query.filters
    ? data.filter((record) => evaluateGroup(asRecord(record), query.filters as FilterGroup, columnsMap))
    : data.slice();

  const term = query.search?.trim();
  if (term) {
    rows = rows.filter((record) => matchesSearch(asRecord(record), term, columns));
  }

  if (query.sorting.length) {
    rows = rows
      .slice()
      .sort((a, b) => compareBySort(asRecord(a), asRecord(b), query.sorting, columnsMap));
  }

  const total = rows.length;
  const page = Math.max(1, query.pagination.page);
  const pageSize = Math.max(1, query.pagination.pageSize);
  const start = (page - 1) * pageSize;

  return {
    data: rows.slice(start, start + pageSize),
    pagination: { page, pageSize, total: query.skipCount ? null : total },
  };
}
