import type {
  DataTableEndpointFieldMeta,
  DataTableEndpointMeta,
  DataTableFieldOptions,
  DataTableFieldType,
  DataTableResult,
  Filter,
  FilterGroup,
  NullaryOperator,
  ScalarOperator,
  TextOperator,
} from "./types.js";

const TEXT_OPERATORS = new Set<TextOperator>(["contains", "startsWith", "endsWith", "notContains", "notStartsWith", "notEndsWith"]);
const SCALAR_OPERATORS = new Set<ScalarOperator>(["eq", "neq", "gt", "gte", "lt", "lte", ...TEXT_OPERATORS]);

const NULLARY_OPERATORS = new Set<NullaryOperator>(["isNull", "isNotNull"]);

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isScalarValue(val: unknown): val is string | number | boolean {
  return typeof val === "string" || typeof val === "number" || typeof val === "boolean";
}

function isStringOrNumber(val: unknown): val is string | number {
  return typeof val === "string" || typeof val === "number";
}

/**
 * Dependency-free type guard (no schema library): checks whether an `unknown`
 * value, for example one decoded from a URL, is a valid `Filter` according to
 * this package's own types.
 *
 * A leaf never carries `filters`. An object with `field`/`operator`/`value`
 * plus `filters: []` is rejected, because the helpers treat a node as a group
 * when `"filters" in node` is true, so accepting it would break the type
 * assumption.
 *
 * @example
 * ```ts
 * isFilter({ field: "age", operator: "gt", value: 18 }); // true
 * isFilter({ field: "age", operator: "gt", value: [1, 2] }); // false
 * ```
 */
export function isFilter(val: unknown): val is Filter {
  if (!isPlainObject(val)) return false;
  if (typeof val.field !== "string") return false;
  if ("filters" in val) return false;

  const operator = val.operator;
  if (typeof operator !== "string") return false;

  if (TEXT_OPERATORS.has(operator as TextOperator)) {
    return typeof val.value === "string";
  }
  if (SCALAR_OPERATORS.has(operator as ScalarOperator)) {
    return isScalarValue(val.value);
  }
  if (NULLARY_OPERATORS.has(operator as NullaryOperator)) {
    return true;
  }
  if (operator === "between") {
    return (
      Array.isArray(val.value) &&
      val.value.length === 2 &&
      isStringOrNumber(val.value[0]) &&
      isStringOrNumber(val.value[1])
    );
  }
  if (operator === "in" || operator === "notIn") {
    return Array.isArray(val.value) && val.value.every(isStringOrNumber);
  }
  return false;
}

/** Group shape: `AND`/`OR` plus a `filters` array, without the leaf fields (`field`/`value`). */
function isGroupShape(val: Record<string, unknown>): boolean {
  return (val.operator === "AND" || val.operator === "OR") && Array.isArray(val.filters) && !("field" in val) && !("value" in val);
}

/**
 * Type guard for a `FilterGroup`: the group and every nested group and leaf
 * must be valid. It is not recursive (it uses an explicit stack), so thousands
 * of nested groups do not overflow the call stack. It applies no depth or size
 * limit; use `decodeFilterParam` for a bounded, canonical tree.
 *
 * @example
 * ```ts
 * isFilterGroup({ operator: "AND", filters: [{ field: "a", operator: "isNull" }] }); // true
 * isFilterGroup({ operator: "NOT", filters: [] }); // false
 * ```
 */
export function isFilterGroup(val: unknown): val is FilterGroup {
  if (!isPlainObject(val) || !isGroupShape(val)) return false;
  const stack: Array<Record<string, unknown>> = [val];
  while (stack.length) {
    const group = stack.pop()!;
    for (const child of group.filters as unknown[]) {
      if (isPlainObject(child) && isGroupShape(child)) stack.push(child);
      else if (!isFilter(child)) return false;
    }
  }
  return true;
}

const FIELD_TYPES = new Set<DataTableFieldType>(["text", "number", "boolean", "date", "datetime", "enum"]);
const FILTER_OPERATORS = new Set<string>([...SCALAR_OPERATORS, ...NULLARY_OPERATORS, "between", "in", "notIn"]);
const LIMIT_KEYS = ["maxPageSize", "maxFilterDepth", "maxFilterCount", "maxInValues", "maxSearchLength", "maxSortCount"] as const;

function isPositiveInteger(val: unknown): val is number {
  return typeof val === "number" && Number.isSafeInteger(val) && val > 0;
}

function isFieldMeta(val: unknown): val is DataTableEndpointFieldMeta {
  if (!isPlainObject(val)) return false;
  return (
    FIELD_TYPES.has(val.type as DataTableFieldType) &&
    Array.isArray(val.filterOperators) &&
    val.filterOperators.every((op) => typeof op === "string" && FILTER_OPERATORS.has(op)) &&
    typeof val.sortable === "boolean" &&
    typeof val.searchable === "boolean" &&
    (val.hasOptions === undefined || typeof val.hasOptions === "boolean")
  );
}

/**
 * Validates a field options response received over the network. An unknown
 * `version` or a malformed option makes it return `false`; the client then
 * disables the filter of that column.
 *
 * @experimental May change in any release while the package is in 0.x.
 */
export function isDataTableFieldOptions(val: unknown): val is DataTableFieldOptions {
  if (!isPlainObject(val) || val.version !== 1 || !Array.isArray(val.options)) return false;
  return val.options.every((option) => isPlainObject(option) && typeof option.label === "string" && isStringOrNumber(option.value));
}

/**
 * Validates an endpoint meta response received over the network. An unknown
 * `version` also returns `false`: the client then ignores the meta and falls
 * back to its own defaults instead of applying limits whose meaning it does
 * not know.
 */
export function isDataTableEndpointMeta(val: unknown): val is DataTableEndpointMeta {
  if (!isPlainObject(val) || val.version !== 1 || typeof val.primaryKey !== "string") return false;
  const protocol = val.protocol;
  if (!isPlainObject(protocol) || !isPositiveInteger(protocol.version)) return false;
  if (!Array.isArray(protocol.supported) || !protocol.supported.length || !protocol.supported.every(isPositiveInteger)) return false;
  const limits = val.limits;
  if (!isPlainObject(limits)) return false;
  if (!LIMIT_KEYS.every((key) => isPositiveInteger(limits[key]))) return false;
  if (limits.maxOffset !== null && !(typeof limits.maxOffset === "number" && Number.isSafeInteger(limits.maxOffset) && limits.maxOffset >= 0)) {
    return false;
  }
  if (!isPlainObject(val.fields)) return false;
  if (val.export !== undefined && !isExportMeta(val.export)) return false;
  return Object.values(val.fields).every(isFieldMeta);
}

function isExportMeta(val: unknown): boolean {
  return (
    isPlainObject(val) &&
    isFormatLimits(val.formats) &&
    Array.isArray(val.fields) &&
    val.fields.every((f) => typeof f === "string")
  );
}

const SERVER_EXPORT_FORMATS = new Set<unknown>(["csv", "excel", "pdf"]);

/** An unknown format key is ignored rather than rejected: a new format must not make an older client discard the meta. */
function isFormatLimits(val: unknown): boolean {
  return isPlainObject(val) && Object.entries(val).every(([key, limit]) => !SERVER_EXPORT_FORMATS.has(key) || isPositiveInteger(limit));
}

function isNonNegativeInteger(val: unknown): val is number {
  return typeof val === "number" && Number.isSafeInteger(val) && val >= 0;
}

/**
 * Validates the OUTER envelope of a query response received over the network:
 * `data` is an array, `pagination.page` and `pageSize` are positive safe
 * integers, and `total` is `null` or a non-negative safe integer. The shape of
 * the rows (`T`) is not validated; that is the consumer's schema. Without this
 * check, a 2xx body altered by a proxy or coming from the wrong endpoint could
 * produce a `NaN` page count, a render error or an endless export loop.
 */
export function isDataTableResultEnvelope(val: unknown): val is DataTableResult<unknown> {
  if (!isPlainObject(val) || !Array.isArray(val.data)) return false;
  const pagination = val.pagination;
  if (!isPlainObject(pagination)) return false;
  return (
    isPositiveInteger(pagination.page) &&
    isPositiveInteger(pagination.pageSize) &&
    (pagination.total === null || isNonNegativeInteger(pagination.total))
  );
}
