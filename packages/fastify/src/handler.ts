import { isExpression } from "kysely";
import type { Expression, Kysely, SelectQueryBuilder, SqlBool } from "kysely";
import type { DataTableQuery, DataTableResult } from "@datatablex/core";
import type { BaseCtx, DataTableEndpointConfig } from "./types.js";
import { escapeLike, filterExpression } from "./filterExpression.js";
import { FieldNotAllowedError, InvalidScopeError } from "./errors.js";
import { assertValidEndpointConfig } from "./config.js";
import { resolveLimits } from "./limits.js";
import { projectedKeys } from "./projection.js";

/**
 * The real return type of `db.selectFrom(table)` uses Kysely's internal
 * `ExtractTableAlias<DB, TB>` helper type, because `table` is a generic that is
 * only known at runtime. Even though it is structurally identical to `TB`, it
 * is NOT the same type for the compiler and causes a mismatch at every step of
 * the chain (`where`/`select`/`orderBy`). It is enough to cast to `Qb<DB, TB>`
 * at a single boundary point and run the rest of the chain on this type.
 */
export type Qb<DB, TB extends keyof DB & string> = SelectQueryBuilder<DB, TB, object>;

/**
 * The return value of `scope` must really be an expression and must not be a
 * subquery builder itself (`eb.selectFrom(...)` alone is not a boolean; it must
 * be wrapped with `eb.exists(...)`). The check relies on Kysely's public
 * `isExpression` and on the node kind, not on internal clause fields.
 *
 * @throws {InvalidScopeError} When the value is not a boolean expression.
 */
function assertScopeExpression(value: unknown): asserts value is Expression<SqlBool> {
  if (isExpression(value) && value.toOperationNode().kind !== "SelectQueryNode") return;
  const received = value === null ? "null" : typeof value === "object" ? (value.constructor?.name ?? "object") : typeof value;
  throw new InvalidScopeError(received);
}

/**
 * Builds scope + filter + search (WHERE) and user sorting + `stableSort`
 * (ORDER BY) — the query and the export go through the SAME setup. `filtered`
 * has no ordering (for COUNT); `ordered` adds the ordering to the same
 * conditions. The projection and LIMIT/OFFSET are left to the caller.
 *
 * @throws {FieldNotAllowedError} When `query.sorting` names a field that is not `sortable`, or a filter uses a field or operator outside the allowlist.
 * @throws {InvalidScopeError} When `config.scope` does not return a boolean expression.
 * @throws {InvalidFilterValueError} When a field's `parseValue` throws.
 */
export function buildDataTableQuery<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  db: Kysely<DB>,
  config: DataTableEndpointConfig<DB, TB, Ctx>,
  query: Pick<DataTableQuery, "filters" | "search" | "sorting">,
  ctx: Ctx,
): { filtered: Qb<DB, TB>; ordered: Qb<DB, TB> } {
  const { fields, table, primaryKey } = config;
  // `primaryKey` is always at the END of the tiebreaker — if `stableSort` is
  // not given (or is an empty array) it becomes the only tiebreaker; if it is
  // given without the PK, the PK is appended at the end. Otherwise
  // `stableSort: []` would produce no ORDER BY at all, and a non-unique column
  // would not give a deterministic order among equal rows — which causes
  // duplicate or missing rows across pages in offset pagination.
  const pkColumn = fields[primaryKey]!.column;
  const configuredStableSort = config.stableSort ?? [];
  const stableSort = configuredStableSort.some((s) => s.column === pkColumn)
    ? configuredStableSort
    : [...configuredStableSort, { column: pkColumn, direction: "asc" as const }];

  const qb: Qb<DB, TB> = db.selectFrom(table) as unknown as Qb<DB, TB>;
  // Scope, filter and search are combined in a single WHERE; COUNT carries the
  // same conditions. Because `scope` can only return an expression, it cannot
  // touch any other part of the query (ORDER BY, LIMIT, SELECT, JOIN).
  // Filter + search are split off here, BEFORE the ordering — the count query
  // never inherits an ORDER BY.
  const filtered = qb.where((eb) => {
    const parts: Expression<SqlBool>[] = [];
    if (config.scope) {
      const scoped: unknown = config.scope(eb, ctx);
      assertScopeExpression(scoped);
      parts.push(scoped);
    }
    if (query.filters) parts.push(filterExpression(eb, query.filters, fields));
    if (query.search?.trim()) {
      const term = `%${escapeLike(query.search.trim())}%`;
      const searchable = Object.values(fields).filter((f) => f.searchable);
      // `term` is a string literal; Kysely validates it only when it statically
      // knows the SQL type of the column. `DB` is fully generic here, so that
      // information is missing — the same accepted type cost described in the
      // projection note in `handleDataTableQuery` below.
      if (searchable.length) parts.push(eb.or(searchable.map((f) => eb(f.column, "ilike", term as never))));
    }
    return parts.length ? eb.and(parts) : eb.lit(true);
  });

  let ordered = filtered;
  const orderedColumns = new Set<string>();
  for (const s of query.sorting) {
    const field = fields[s.field];
    if (!field?.sortable) throw new FieldNotAllowedError(s.field);
    ordered = ordered.orderBy(field.column, s.direction);
    orderedColumns.add(field.column);
  }
  // If the user's sorting already includes the column of a stableSort entry,
  // adding the tiebreaker again would produce a dead key such as
  // `ORDER BY "id" desc, "id" asc` — stability is already provided by the first
  // key.
  for (const s of stableSort) {
    if (orderedColumns.has(s.column)) continue;
    ordered = ordered.orderBy(s.column, s.direction);
  }
  return { filtered, ordered };
}

/**
 * Runs filtering, search, safe sorting, `total` and the camelCase projection in
 * a single flow. Because `select` is built at runtime, Kysely cannot infer the
 * shape of the returned rows statically — the guarantee of correctness comes
 * from the contract tests, not from the type here.
 *
 * `page` and `pageSize` are clamped: `page` to at least 1 and `pageSize` to the
 * range 1 to `maxPageSize`. With `skipCount`, the COUNT query is not run and
 * `pagination.total` is `null`.
 *
 * @throws {Error} When the endpoint config is invalid (see `assertValidEndpointConfig`).
 * @throws {FieldNotAllowedError} When `query.sorting` names a field that is not `sortable`, or a filter uses a field or operator outside the allowlist.
 * @throws {InvalidScopeError} When `config.scope` does not return a boolean expression.
 * @throws {InvalidFilterValueError} When a field's `parseValue` throws.
 */
export async function handleDataTableQuery<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  db: Kysely<DB>,
  config: DataTableEndpointConfig<DB, TB, Ctx>,
  query: DataTableQuery,
  ctx: Ctx,
): Promise<DataTableResult<unknown>> {
  assertValidEndpointConfig(config);
  const { fields } = config;
  const { maxPageSize } = resolveLimits(config);
  const page = Math.max(1, query.pagination.page);
  const pageSize = Math.min(Math.max(1, query.pagination.pageSize), maxPageSize);

  const { filtered, ordered } = buildDataTableQuery(db, config, query, ctx);
  const countQuery = filtered.select((eb) => eb.fn.countAll<string>().as("total"));
  const selectedKeys = projectedKeys(config);
  const dataQuery = ordered
    .select((eb) => selectedKeys.map((key) => eb.ref(fields[key]!.column).as(key)))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [rows, countResult] = await Promise.all([
    dataQuery.execute(),
    query.skipCount ? Promise.resolve(null) : countQuery.executeTakeFirstOrThrow(),
  ]);

  return {
    data: rows as unknown[],
    pagination: { page, pageSize, total: countResult ? Number((countResult as { total: string }).total) : null },
  };
}
