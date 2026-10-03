import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import type { Filter, FilterGroup, ScalarOperator } from "@datatablex/core";
import type { FieldConfig } from "./types.js";
import { FieldNotAllowedError, InvalidFilterValueError } from "./errors.js";

/** The text operators that translate to `ILIKE` / `NOT ILIKE`. */
type LikeOperator = "contains" | "startsWith" | "endsWith" | "notContains" | "notStartsWith" | "notEndsWith";

/** SQL comparison operator for each remaining scalar operator. */
const SQL_OPERATOR: Record<Exclude<ScalarOperator, LikeOperator>, "=" | "!=" | ">" | ">=" | "<" | "<="> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * The `ILIKE` counterpart of each text operator. The term is escaped with
 * `escapeLike` and sent as a bind parameter; the negative operators use the
 * same pattern with `NOT ILIKE` and exclude NULL rows through SQL's
 * three-valued logic.
 */
const LIKE: Record<LikeOperator, { op: "ilike" | "not ilike"; pattern: (escaped: string) => string }> = {
  contains: { op: "ilike", pattern: (s) => `%${s}%` },
  startsWith: { op: "ilike", pattern: (s) => `${s}%` },
  endsWith: { op: "ilike", pattern: (s) => `%${s}` },
  notContains: { op: "not ilike", pattern: (s) => `%${s}%` },
  notStartsWith: { op: "not ilike", pattern: (s) => `${s}%` },
  notEndsWith: { op: "not ilike", pattern: (s) => `%${s}` },
};

/**
 * Applies the field's `parseValue` (if any) to a filter value.
 *
 * `raw` is always a SINGLE scalar value — array and tuple elements are passed
 * one by one by the caller, so no `Array.isArray` branch is needed here.
 * `parseValue` is CONSUMER code; if its failure were not wrapped it would carry
 * no `statusCode` and Fastify would return a 500.
 *
 * @throws {InvalidFilterValueError} When `parseValue` throws.
 */
function parseFilterValue(raw: unknown, field: string, parseFn?: (v: unknown) => unknown): unknown {
  if (!parseFn) return raw;
  try {
    return parseFn(raw);
  } catch (cause) {
    throw new InvalidFilterValueError(field, cause);
  }
}

/**
 * Escapes the LIKE wildcards (`\`, `%`, `_`) in a search term.
 *
 * Defensive: even if a non-string value that zod should have rejected leaks
 * into `contains`/`startsWith`/`endsWith` (for example a number field without
 * `parseValue`), this does not crash. In PostgreSQL the default escape
 * character is already `\`, and the value is sent as a bind parameter, so an
 * explicit `ESCAPE` clause is not needed.
 *
 * @param raw - The term to escape; `null` and `undefined` become an empty string.
 * @returns The term as a string with every `\`, `%` and `_` prefixed by `\`.
 */
export function escapeLike(raw: unknown): string {
  return String(raw ?? "").replace(/[\\%_]/g, "\\$&");
}

/**
 * `DB` is a fully generic type parameter for this package — `FieldConfig.type`
 * ("text"/"number"/…) is a runtime label and is not bound to the real column
 * types of `DB` at compile time. Kysely can validate an operand only when it
 * knows the static SQL type of the column; the `unknown` returned from
 * `parseValue` (or a string-literal search term) carries no such information.
 * The same accepted type cost described in the projection note in `handler.ts`
 * applies here on the operand side — the guarantee of correctness comes from
 * the contract tests, not from the type.
 */
function asOperand(value: unknown) {
  return value as never;
}

/**
 * Translates one leaf filter into a Kysely boolean expression, after checking
 * it against the field allowlist.
 *
 * @throws {FieldNotAllowedError} When the field is not defined or the operator is not enabled for it in `filterOperators`.
 * @throws {InvalidFilterValueError} When the field's `parseValue` throws.
 */
export function leafExpression<DB, TB extends keyof DB & string>(
  eb: ExpressionBuilder<DB, TB>,
  filter: Filter,
  fields: Record<string, FieldConfig<DB, TB, never>>,
): Expression<SqlBool> {
  const field = fields[filter.field];
  if (!field || !field.filterOperators?.includes(filter.operator)) {
    throw new FieldNotAllowedError(filter.field);
  }

  switch (filter.operator) {
    case "isNull":
      return eb(field.column, "is", null);
    case "isNotNull":
      return eb(field.column, "is not", null);
    case "between": {
      const [a, b] = filter.value.map((v) => parseFilterValue(v, filter.field, field.parseValue)) as [unknown, unknown];
      return eb.between(field.column, asOperand(a), asOperand(b));
    }
    case "in": {
      const vals = filter.value.map((v) => parseFilterValue(v, filter.field, field.parseValue));
      return vals.length ? eb(field.column, "in", asOperand(vals)) : eb.lit(false);
    }
    case "notIn": {
      const vals = filter.value.map((v) => parseFilterValue(v, filter.field, field.parseValue));
      return vals.length ? eb(field.column, "not in", asOperand(vals)) : eb.lit(true);
    }
    case "contains":
    case "startsWith":
    case "endsWith":
    case "notContains":
    case "notStartsWith":
    case "notEndsWith": {
      const { op, pattern } = LIKE[filter.operator];
      return eb(field.column, op, asOperand(pattern(escapeLike(parseFilterValue(filter.value, filter.field, field.parseValue)))));
    }
    default:
      return eb(field.column, SQL_OPERATOR[filter.operator], asOperand(parseFilterValue(filter.value, filter.field, field.parseValue)));
  }
}

/**
 * Recurses over a filter group and translates it into a Kysely boolean
 * expression; this is the entry point that the query handler calls.
 *
 * An EMPTY GROUP is the nested form of the `eb.and([])` problem: a top-level
 * guard only protects the root node, and a `{ operator: "AND", filters: [] }`
 * embedded inside a non-empty parent group never reaches it. The zod schema
 * also rejects this with `min(1)`, but that does not make the SQL builder's own
 * neutral-element branch UNNECESSARY: they are two components that can change
 * independently. An empty `AND` becomes `true` and an empty `OR` becomes
 * `false`.
 *
 * @throws {FieldNotAllowedError} When a leaf uses a field or operator outside the allowlist.
 * @throws {InvalidFilterValueError} When a field's `parseValue` throws.
 */
export function filterExpression<DB, TB extends keyof DB & string>(
  eb: ExpressionBuilder<DB, TB>,
  node: FilterGroup,
  fields: Record<string, FieldConfig<DB, TB, never>>,
): Expression<SqlBool> {
  const parts = node.filters.map((child) => ("filters" in child ? filterExpression(eb, child, fields) : leafExpression(eb, child, fields)));
  if (!parts.length) return node.operator === "AND" ? eb.lit(true) : eb.lit(false);
  return node.operator === "AND" ? eb.and(parts) : eb.or(parts);
}
