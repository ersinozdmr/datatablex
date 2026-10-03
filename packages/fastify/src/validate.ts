import { z } from "zod";
import { countFilterLeaves, filterDepth } from "@datatablex/core";
import type { DataTableQuery, Filter, FilterGroup } from "@datatablex/core";
import type { BaseCtx, DataTableEndpointConfig, FieldConfig, FieldType } from "./types.js";
import { SearchNotSupportedError } from "./errors.js";
import { assertValidEndpointConfig } from "./config.js";
import { resolveLimits } from "./limits.js";

const scalarValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const arrayElementSchema = z.union([z.string(), z.number()]);

// Text operators REQUIRE a `string` — the `number`/`boolean` values that
// `ScalarOperator` structurally allows are rejected here. Without this
// distinction the `String(raw ?? "")` inside `escapeLike` would stop being a
// defensive layer and become the PRIMARY converter: `value: true` would
// silently turn into a `%true%` search and the client mistake would not
// produce a 400.
const textFilterSchema = z.object({
  field: z.string(),
  operator: z.enum(["contains", "startsWith", "endsWith", "notContains", "notStartsWith", "notEndsWith"]),
  value: z.string(),
});

const comparisonFilterSchema = z.object({
  field: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
  value: scalarValueSchema,
});

const betweenFilterSchema = z.object({
  field: z.string(),
  operator: z.literal("between"),
  value: z.tuple([arrayElementSchema, arrayElementSchema]),
});

const inFilterSchema = z.object({
  field: z.string(),
  operator: z.enum(["in", "notIn"]),
  value: z.array(arrayElementSchema),
});

const nullaryFilterSchema = z.object({
  field: z.string(),
  operator: z.enum(["isNull", "isNotNull"]),
});

const filterSchema: z.ZodType<Filter> = z.union([
  textFilterSchema,
  comparisonFilterSchema,
  betweenFilterSchema,
  inFilterSchema,
  nullaryFilterSchema,
]);

// `min(1)` — an empty `FilterGroup` is closed in two layers: here it becomes a
// 400, and `filterExpression` separately maps it to the neutral element.
const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    operator: z.enum(["AND", "OR"]),
    filters: z.array(z.union([filterSchema, filterGroupSchema])).min(1),
  }),
);

const sortSchema = z.object({
  field: z.string(),
  direction: z.enum(["asc", "desc"]),
});

const dataTableQuerySchema = z.object({
  pagination: z.object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  }),
  sorting: z.array(sortSchema),
  filters: filterGroupSchema.nullable(),
  search: z.string().optional(),
  skipCount: z.boolean().optional(),
});

/** Limits enforced by the iterative pre-scan in `checkFilterShapeLimits`. */
interface FilterShapeLimits {
  maxFilterDepth: number;
  maxFilterCount: number;
  maxInValues: number;
}

/** Builds a `too_big` zod issue on the `filters` path. */
function tooBigIssue(maximum: number, message: string): z.ZodIssue {
  return { code: z.ZodIssueCode.too_big, maximum, type: "array", inclusive: true, path: ["filters"], message };
}

/**
 * The `filters` body is scanned here, BEFORE it enters zod's recursive
 * `z.lazy()` schema, with an explicit stack — that is, WITHOUT recursion. The
 * goal is not shape or field correctness (that still belongs to the
 * `dataTableQuerySchema.parse` call below), only to cut abuse cost early:
 * thousands of nested groups return a 400 here BEFORE they can overflow the JS
 * call stack inside `z.lazy()` and produce a 500.
 *
 * @throws {z.ZodError} When the depth, the number of leaves or the length of an
 * `in`/`notIn` array exceeds its limit.
 */
function checkFilterShapeLimits(rawFilters: unknown, limits: FilterShapeLimits): void {
  if (rawFilters === null || rawFilters === undefined) return;

  let leafCount = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: rawFilters, depth: 1 }];

  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.depth > limits.maxFilterDepth) {
      throw new z.ZodError([tooBigIssue(limits.maxFilterDepth, `filters can be at most ${limits.maxFilterDepth} levels deep`)]);
    }
    if (!frame.node || typeof frame.node !== "object") continue;
    const children = (frame.node as { filters?: unknown }).filters;
    if (!Array.isArray(children)) continue;

    for (const child of children) {
      const childFilters = child && typeof child === "object" ? (child as { filters?: unknown }).filters : undefined;
      if (Array.isArray(childFilters)) {
        stack.push({ node: child, depth: frame.depth + 1 });
        continue;
      }

      leafCount++;
      if (leafCount > limits.maxFilterCount) {
        throw new z.ZodError([tooBigIssue(limits.maxFilterCount, `filters can contain at most ${limits.maxFilterCount} leaves`)]);
      }
      const value = child && typeof child === "object" ? (child as { value?: unknown }).value : undefined;
      if (Array.isArray(value) && value.length > limits.maxInValues) {
        throw new z.ZodError([tooBigIssue(limits.maxInValues, `in/notIn can contain at most ${limits.maxInValues} items`)]);
      }
    }
  }
}

/**
 * The wire formats of `date` and `datetime` are DELIBERATELY DIFFERENT shapes:
 *
 * - `date`: ONLY a calendar day, `YYYY-MM-DD`. It carries no time component —
 *   a date column has no instant semantics, and
 *   accepting a time would silently loosen this distinction.
 * - `datetime`: a FULL instant — the time component AND an explicit timezone
 *   (`Z` or a numeric offset) are REQUIRED. A local time without a timezone
 *   (`"2026-09-03T14:00"`) would make the UTC wire contract depend on the
 *   server/database session timezone — the same request body could return
 *   different row sets in different environments.
 *
 * Epoch numbers and locale-dependent formats (`03.09.2026`, `9/3/2026`) are
 * rejected in both — `Date.parse` accepts some of them in an engine-dependent
 * way, so it is NOT a sufficient gate on its own; the shape is checked first,
 * then the validity (`2026-02-31` matches the shape but is not a date).
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * `Date.parse` is NOT a sufficient validity gate on its own: V8 silently rolls
 * `"2026-02-31"` over to 3 March and does not return NaN. Round-tripping the
 * calendar components prevents a non-existent day from silently shifting to
 * another day (and rows the user never asked for from being returned).
 */
function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

const isoDateOnlySchema = z
  .string()
  .regex(DATE_ONLY, "must be in ISO 8601 date format (YYYY-MM-DD) without a time or timezone")
  .refine(isRealCalendarDate, "is not a valid date");

const isoDateTimeSchema = z
  .string()
  .regex(DATETIME_WITH_ZONE, "must be in ISO 8601 date-time format and include a timezone (Z or ±HH:MM)")
  .refine((v) => !Number.isNaN(Date.parse(v)) && isRealCalendarDate(v), "is not a valid date-time");

/**
 * The value schema DERIVED from `FieldConfig.type` — the "field type +
 * operator + value" validation. The `Filter` type narrows `value` only by the
 * OPERATOR (`contains` structurally even accepts a `boolean`); matching the
 * field's own type cannot be enforced at compile time, so it is enforced here
 * at runtime.
 *
 * Note that `in`/`notIn` can never validate on a `boolean` field: the array
 * elements of `Filter` are `string | number`, so such a request gets a 400
 * here. This is deliberate — a multi-selection on a boolean column is just the
 * two values of `eq` anyway.
 *
 * @param type - The field type to build the value schema for.
 * @returns A zod schema that accepts a single (non-array) filter value of that type.
 */
export function valueSchemaFor(type: FieldType): z.ZodTypeAny {
  switch (type) {
    case "text":
      return z.string();
    case "number":
      return z.number().finite();
    case "boolean":
      return z.boolean();
    case "enum":
      return z.union([z.string(), z.number()]);
    case "date":
      return isoDateOnlySchema;
    case "datetime":
      return isoDateTimeSchema;
  }
}

/** Human-readable description of the value expected for each field type, used in value-type error messages. */
export const EXPECTED_BY_TYPE: Record<FieldType, string> = {
  text: "string",
  number: "finite number",
  boolean: "boolean",
  date: "ISO 8601 date string",
  datetime: "ISO 8601 date-time string",
  enum: "string or number",
};

/** Describes a received value as `type (json)` for error messages. */
function describeValue(value: unknown): string {
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

/**
 * Compares the VALUE of each leaf filter with the field's `type` and appends an
 * issue for every mismatch.
 *
 * Allowlist violations are NOT THE JOB OF THIS LAYER: a field that is not
 * defined, or an operator that is not enabled for the field, is silently
 * skipped here and left to the `FieldNotAllowedError` of `leafExpression`. The
 * order is deliberate — the allowlist is the primary gate; the type check is a
 * second gate after it. Otherwise a request with a field or operator outside
 * the allowlist would produce a 400 whose error depends on the value.
 */
function checkFilterValueTypes<DB, TB extends keyof DB & string>(
  node: FilterGroup,
  fields: Record<string, FieldConfig<DB, TB, never>>,
  issues: z.ZodIssue[],
): void {
  for (const child of node.filters) {
    if ("filters" in child) {
      checkFilterValueTypes(child, fields, issues);
      continue;
    }
    // Nullary operators (`isNull`/`isNotNull`) carry no value, so there is
    // nothing to validate. The check is made on the PRESENCE of `value`
    // instead of on `operator`; that is also what narrows the discriminated
    // union here.
    if (!("value" in child)) continue;

    const field = fields[child.field];
    if (!field || !field.filterOperators?.includes(child.operator)) continue;

    const schema = valueSchemaFor(field.type);
    const isMultiValue = Array.isArray(child.value);
    const values: unknown[] = isMultiValue ? (child.value as unknown[]) : [child.value];

    values.forEach((value, index) => {
      const result = schema.safeParse(value);
      if (result.success) return;
      issues.push({
        code: z.ZodIssueCode.custom,
        path: isMultiValue ? ["filters", child.field, index] : ["filters", child.field],
        message: `Field "${child.field}" has type: "${field.type}" — expected ${EXPECTED_BY_TYPE[field.type]}, received: ${describeValue(value)}`,
      });
    });
  }
}

/**
 * The REQUEST rule for leaves that target a sensitive column (or an alias of
 * it): a query can contain at most ONE of them, and it must be a direct child
 * of the root `AND`. A leaf under an `OR` or in a nested group would allow
 * testing several guesses in the same request; the rule reduces the number of
 * guesses per request to 1. A field that is not in the allowlist is skipped here
 * (`leafExpression` rejects it).
 */
function checkSensitiveLeaves<DB, TB extends keyof DB & string>(
  root: FilterGroup,
  fields: Record<string, FieldConfig<DB, TB, never>>,
  issues: z.ZodIssue[],
): void {
  const sensitiveColumns = new Set(
    Object.values(fields)
      .filter((f) => f.sensitive)
      .map((f) => f.column as string),
  );
  if (!sensitiveColumns.size) return;

  const found: Array<{ field: string; direct: boolean }> = [];
  const stack: Array<{ node: FilterGroup; isRoot: boolean }> = [{ node: root, isRoot: true }];
  while (stack.length) {
    const { node, isRoot } = stack.pop()!;
    for (const child of node.filters) {
      if ("filters" in child) {
        stack.push({ node: child, isRoot: false });
        continue;
      }
      const field = fields[child.field];
      if (field && sensitiveColumns.has(field.column as string)) {
        found.push({ field: child.field, direct: isRoot && node.operator === "AND" });
      }
    }
  }
  const nested = found.find((leaf) => !leaf.direct);
  if (nested) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["filters", nested.field],
      message: `"${nested.field}" filters a sensitive column — it can only be a direct child of the root AND group (it cannot be under an OR or in a nested group)`,
    });
  } else if (found.length > 1) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["filters", found[1]!.field],
      message: `a query can contain at most one sensitive filter (found: ${found.map((leaf) => leaf.field).join(", ")})`,
    });
  }
}

/** Returns the length of the longest `in`/`notIn` array anywhere in the filter tree (0 if there is none). */
function maxArrayValueLength(node: FilterGroup): number {
  let max = 0;
  for (const child of node.filters) {
    if ("filters" in child) {
      max = Math.max(max, maxArrayValueLength(child));
    } else if (child.operator === "in" || child.operator === "notIn") {
      max = Math.max(max, child.value.length);
    }
  }
  return max;
}

/**
 * Validates a raw request body as a `DataTableQuery` against the endpoint
 * config.
 *
 * `maxFilterDepth`, `maxFilterCount`, `maxInValues`, `maxSearchLength`,
 * `maxSortCount` and the OFFSET bound are checked here — a request that
 * exceeds them is rejected with a 400. They close a class of risk that
 * `maxPageSize` does not cover: a cheap request creating an expensive query,
 * JSON parse or `ORDER BY` load.
 *
 * The VALUE of each leaf filter is also validated against the field's `type`
 * (`checkFilterValueTypes`). Shape validation (operator → value format) and
 * type validation (field → value type) are separate layers; the first lives in
 * `dataTableQuerySchema`, the second is derived from `fields` here.
 *
 * @throws {z.ZodError} When the body is malformed or breaks a limit, a value
 * does not match its field type, or a sensitive field is filtered in a way the
 * request rules forbid.
 * @throws {SearchNotSupportedError} When `search` is sent to an endpoint that has no `searchable` field.
 * @throws {Error} When the endpoint config itself is invalid (see `assertValidEndpointConfig`).
 */
export function validateDataTableQuery<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  body: unknown,
  config: DataTableEndpointConfig<DB, TB, Ctx>,
): DataTableQuery {
  assertValidEndpointConfig(config);
  const limits = resolveLimits(config);
  const { maxSortCount, maxFilterDepth, maxFilterCount, maxInValues, maxSearchLength, maxPageSize } = limits;
  const maxOffset = limits.maxOffset ?? Number.MAX_SAFE_INTEGER;

  if (body && typeof body === "object" && "filters" in body) {
    checkFilterShapeLimits((body as { filters?: unknown }).filters, { maxFilterDepth, maxFilterCount, maxInValues });
  }

  const query = dataTableQuerySchema.parse(body) as DataTableQuery;

  const issues: z.ZodIssue[] = [];
  if (query.sorting.length > maxSortCount) {
    issues.push({ code: z.ZodIssueCode.too_big, maximum: maxSortCount, type: "array", inclusive: true, path: ["sorting"], message: `sorting can contain at most ${maxSortCount} items` });
  }
  // A second key for the same field is dead in ORDER BY (the first one already
  // decides); it is rejected instead of silently dropped so that the client's
  // mistake becomes visible.
  const seenSortFields = new Set<string>();
  query.sorting.forEach((s, index) => {
    if (seenSortFields.has(s.field)) {
      issues.push({ code: z.ZodIssueCode.custom, path: ["sorting", index, "field"], message: `sorting field "${s.field}" is given more than once` });
    }
    seenSortFields.add(s.field);
  });
  if (query.filters) {
    if (filterDepth(query.filters) > maxFilterDepth) {
      issues.push({ code: z.ZodIssueCode.too_big, maximum: maxFilterDepth, type: "array", inclusive: true, path: ["filters"], message: `filters can be at most ${maxFilterDepth} levels deep` });
    }
    if (countFilterLeaves(query.filters) > maxFilterCount) {
      issues.push({ code: z.ZodIssueCode.too_big, maximum: maxFilterCount, type: "array", inclusive: true, path: ["filters"], message: `filters can contain at most ${maxFilterCount} leaves` });
    }
    if (maxArrayValueLength(query.filters) > maxInValues) {
      issues.push({ code: z.ZodIssueCode.too_big, maximum: maxInValues, type: "array", inclusive: true, path: ["filters"], message: `in/notIn can contain at most ${maxInValues} items` });
    }
    checkFilterValueTypes(query.filters, config.fields, issues);
    checkSensitiveLeaves(query.filters, config.fields, issues);
  }
  // OFFSET is computed with the EFFECTIVE pageSize that `handleDataTableQuery`
  // clamps to. Without a bound, `page: 1e300` passes zod's `int()` check and
  // turns into an OFFSET parameter such as `2e+301`, which fails in
  // PostgreSQL's bigint parser and produces a 500.
  const effectivePageSize = Math.min(query.pagination.pageSize, maxPageSize);
  const offset = (query.pagination.page - 1) * effectivePageSize;
  if (!Number.isSafeInteger(offset) || offset > maxOffset) {
    const maxPage = Math.floor(maxOffset / effectivePageSize) + 1;
    issues.push({ code: z.ZodIssueCode.too_big, maximum: maxPage, type: "number", inclusive: true, path: ["pagination", "page"], message: `pagination.page can be at most ${maxPage} at this page size` });
  }
  if (query.search !== undefined && query.search.length > maxSearchLength) {
    issues.push({ code: z.ZodIssueCode.too_big, maximum: maxSearchLength, type: "string", inclusive: true, path: ["search"], message: `search can be at most ${maxSearchLength} characters` });
  }
  if (issues.length) throw new z.ZodError(issues);

  // If `search` is sent to an endpoint that has no `searchable` field, the
  // request is rejected — otherwise the search would be silently ignored and
  // the whole unfiltered table would be returned.
  if (query.search?.trim()) {
    const hasSearchable = Object.values(config.fields).some((f) => f.searchable);
    if (!hasSearchable) throw new SearchNotSupportedError();
  }

  return query;
}
