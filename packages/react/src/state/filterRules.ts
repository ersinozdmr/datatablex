import type { Filter, FilterGroup, FilterOperator } from "@datatablex/core";
import type { ReactDataTableColumn } from "../types.js";
import { columnField } from "@datatablex/core";

/** The field of a rule: the column's backend field (`field ?? key`; a column with a `null` field never produces a rule anyway). */
function fieldOfColumn<T>(column: ReactDataTableColumn<T>): string {
  return columnField(column) ?? column.key;
}

/**
 * Maps each backend field to its column (rules and filter nodes carry a
 * `field`, not a column key). Columns with `field: null` are left out; when
 * several columns share the same field, the first one wins.
 */
export function columnsByField<T>(columns: ReactDataTableColumn<T>[]): Map<string, ReactDataTableColumn<T>> {
  const byField = new Map<string, ReactDataTableColumn<T>>();
  for (const column of columns) {
    const field = columnField(column);
    if (field !== null && !byField.has(field)) byField.set(field, column);
  }
  return byField;
}
import { addDaysToDay, utcIsoToZonedDay, zonedDayStartToUtcIso } from "./timezone.js";

/**
 * The rule model of the filter bar and the advanced builder: a domain layer
 * that is independent of React.
 *
 * A rule does not always map to a single leaf: on a `datetime` column, "on this
 * day" and a day range are compiled into a half-open `gte` + `lt` AND wrapper
 * so that no microseconds are lost at the end of the day. A rule therefore
 * represents the condition the user meant, not a wire leaf.
 */

/** The class of value editor derived from the column type. */
export type RuleKind = "text" | "number" | "date" | "enum" | "boolean";

/** Rule operators available on a text column. */
export type TextRuleOperator =
  | "contains"
  | "notContains"
  | "eq"
  | "neq"
  | "startsWith"
  | "notStartsWith"
  | "endsWith"
  | "notEndsWith";
/** Rule operators available on a number column. */
export type NumberRuleOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between";
/** Day-granularity operators; on a `datetime` column the days are resolved in the column's `timezone`. */
export type DateRuleOperator = "onDay" | "onOrAfter" | "onOrBefore" | "dayBetween";
/** Rule operators that test for a missing value; they carry no `value`. */
export type NullRuleOperator = "isNull" | "isNotNull";

/** Every operator a rule can use. */
export type RuleOperator =
  | TextRuleOperator
  | NumberRuleOperator
  | DateRuleOperator
  | "in"
  | "notIn"
  | NullRuleOperator;

/**
 * A single condition on one field, as the user edits it.
 *
 * The shape of `value` depends on the operator: text is a `string`; number is a
 * `number`, or `[min, max]` for `between`; date is `YYYY-MM-DD`, or
 * `[start, end]` for `dayBetween`; enum is an array of values; boolean is a
 * `boolean`; the NULL operators carry no value. A rule with a missing or invalid
 * value (a draft left half-finished in the editor) does not compile:
 * `ruleToNode` returns `null`.
 */
export interface FilterRule {
  /** Backend field the rule applies to (see `columnsByField`). */
  field: string;
  /** The operator of the rule. */
  operator: RuleOperator;
  /** The operand; its shape depends on `operator`, see the type description. */
  value?: unknown;
}

/**
 * One child of the root `AND`: either a rule the bar can represent
 * (`type: "rule"`) or an external node that is kept as it is
 * (`type: "external"`), such as a filter injected from outside.
 */
export type FilterEntry = { type: "rule"; rule: FilterRule } | { type: "external"; node: Filter | FilterGroup };

const TEXT_OPERATORS: TextRuleOperator[] = [
  "contains",
  "notContains",
  "eq",
  "neq",
  "startsWith",
  "notStartsWith",
  "endsWith",
  "notEndsWith",
];
const NUMBER_OPERATORS: NumberRuleOperator[] = ["eq", "neq", "gt", "gte", "lt", "lte", "between"];
const DATE_OPERATORS: DateRuleOperator[] = ["onDay", "onOrAfter", "onOrBefore", "dayBetween"];
const NULL_OPERATORS: NullRuleOperator[] = ["isNull", "isNotNull"];

/**
 * The operators offered when the column carries no `filterOperators` (neither
 * set by hand nor from the endpoint metadata): the basic set of the column
 * filter box. The backend is not known to enable more than these, so offering a
 * wider list would show the user predictable 400 responses.
 */
function defaultWireOperators<T>(column: ReactDataTableColumn<T>, kind: RuleKind): FilterOperator[] {
  switch (kind) {
    case "text":
      return ["contains"];
    case "number":
      return ["between", "gte", "lte"];
    case "date":
      return column.type === "datetime" ? ["gte", "lt"] : ["between", "gte", "lte"];
    case "enum":
      return ["in"];
    case "boolean":
      return ["eq"];
  }
}

/**
 * The rule kind of a `filterable` column, or `null` when the column cannot be
 * filtered (not `filterable`, no backend field, an unsupported type, or an
 * enum without options). A text column is not tied to a single operator: a
 * field that only has `notContains` enabled can still be filtered in the bar.
 */
export function ruleKindOf<T>(column: ReactDataTableColumn<T>): RuleKind | null {
  // `field: null` means there is no backend counterpart (a computed column): it cannot be filtered.
  if (!column.filterable || columnField(column) === null) return null;
  switch (column.type) {
    case undefined:
    case "text":
      return "text";
    case "number":
    case "currency":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "boolean":
      return "boolean";
    case "enum":
      // While options that will come from the server are still pending, the column counts as
      // filterable; an empty list or an error (`ready`/`error` + empty `options`) is the same
      // as an empty list given by hand.
      return column.options?.length || column.optionsState === "idle" || column.optionsState === "loading" ? "enum" : null;
    default:
      return null;
  }
}

/** ALL the wire operators a rule compiles to; if even one is disabled, the rule is not offered. */
function wireOperatorsOf<T>(column: ReactDataTableColumn<T>, operator: RuleOperator): FilterOperator[] {
  switch (operator) {
    case "onDay":
      return column.type === "datetime" ? ["gte", "lt"] : ["eq"];
    case "onOrAfter":
      return ["gte"];
    case "onOrBefore":
      return column.type === "datetime" ? ["lt"] : ["lte"];
    case "dayBetween":
      return column.type === "datetime" ? ["gte", "lt"] : ["between"];
    default:
      return [operator];
  }
}

/**
 * The rule operators a column can offer, in display order. Only operators whose
 * wire operators are all present in `column.filterOperators` (as narrowed by the
 * endpoint metadata, see `state/endpointMeta.ts`) are kept; a `sensitive` field
 * therefore offers only the `eq`/`in`/`notIn`/NULL operators on its own.
 * Returns an empty array when the column cannot be filtered.
 */
export function ruleOperatorsFor<T>(column: ReactDataTableColumn<T>): RuleOperator[] {
  const kind = ruleKindOf(column);
  if (!kind) return [];
  const allowed = new Set<FilterOperator>(column.filterOperators ?? defaultWireOperators(column, kind));
  const candidates: RuleOperator[] = [
    ...(kind === "text" ? TEXT_OPERATORS : []),
    ...(kind === "number" ? NUMBER_OPERATORS : []),
    ...(kind === "date" ? DATE_OPERATORS : []),
    ...(kind === "enum" ? (["in", "notIn"] as const) : []),
    ...(kind === "boolean" ? (["eq"] as const) : []),
    ...NULL_OPERATORS,
  ];
  return candidates.filter((op) => wireOperatorsOf(column, op).every((wire) => allowed.has(wire)));
}

/** Operators that exclude NULL rows (SQL three-valued logic); a UI can use this to show an "(empty values excluded)" hint. */
export function excludesNulls(operator: RuleOperator): boolean {
  return (
    operator === "neq" ||
    operator === "notContains" ||
    operator === "notStartsWith" ||
    operator === "notEndsWith" ||
    operator === "notIn"
  );
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isDay(value: unknown): value is string {
  return typeof value === "string" && DAY_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Calendar day to the wire instant of a `datetime` column: the START of the day
 * in the column's `timezone` (UTC ISO 8601). A `date` column carries the day as
 * it is, because a date column has no instant semantics.
 */
function dayStart<T>(column: ReactDataTableColumn<T>, day: string): string | null {
  return zonedDayStartToUtcIso(day, column.timezone);
}

/**
 * The inverse of `dayStart`, only when the value is EXACTLY the start of a day.
 * If an instant in the middle of a day (for example a `gte 14:00` injected from
 * a dashboard) were rounded to its day, the filter would silently widen; such a
 * leaf is kept as an external node instead of becoming a rule.
 */
function dayOfStart<T>(column: ReactDataTableColumn<T>, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = utcIsoToZonedDay(value, column.timezone);
  if (!day) return null;
  const start = dayStart(column, day);
  return start !== null && Date.parse(start) === Date.parse(value) ? day : null;
}

function orderedPair<V extends string | number>(value: unknown, valid: (v: unknown) => v is V): [V, V] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [a, b] = value as unknown[];
  if (!valid(a) || !valid(b)) return null;
  // A range entered in reverse is the range the user meant, not an empty result.
  return a > b ? [b, a] : [a, b];
}

function dateRuleToNode<T>(column: ReactDataTableColumn<T>, rule: FilterRule): Filter | FilterGroup | null {
  const field = fieldOfColumn(column);
  const operator = rule.operator as DateRuleOperator;
  const range = operator === "dayBetween" ? orderedPair(rule.value, isDay) : isDay(rule.value) ? ([rule.value, rule.value] as [string, string]) : null;
  if (!range) return null;
  const [from, to] = range;

  if (column.type !== "datetime") {
    if (operator === "onDay") return { field, operator: "eq", value: from };
    if (operator === "onOrAfter") return { field, operator: "gte", value: from };
    if (operator === "onOrBefore") return { field, operator: "lte", value: to };
    return { field, operator: "between", value: [from, to] };
  }

  // `datetime`: half-open upper bound (`lt` the start of the next day). A single
  // inclusive `between` leaf cannot express this, so two-ended rules are
  // compiled into a `gte` + `lt` AND wrapper.
  const start = dayStart(column, from);
  const endExclusive = dayStart(column, addDaysToDay(to, 1));
  if (operator === "onOrAfter") return start === null ? null : { field, operator: "gte", value: start };
  if (operator === "onOrBefore") return endExclusive === null ? null : { field, operator: "lt", value: endExclusive };
  if (start === null || endExclusive === null) return null;
  return {
    operator: "AND",
    filters: [
      { field, operator: "gte", value: start },
      { field, operator: "lt", value: endExclusive },
    ],
  };
}

/**
 * Compiles a rule into a `Filter` or, for a datetime range, into a small group
 * that the rule owns. An operator that does not fit the column type, or a
 * missing or invalid value, returns `null`; an empty multi-select also returns
 * `null`, because `in: []` means "no rows" and contradicts the user's
 * expectation of "no filter".
 *
 * Text terms are trimmed, number and day ranges entered in reverse are put in
 * order, and a rule whose `field` is not the column's field returns `null`.
 *
 * @example
 * ```ts
 * const amount = { key: "amount", type: "number", filterable: true };
 * ruleToNode({ field: "amount", operator: "between", value: [10, 5] }, amount);
 * // { field: "amount", operator: "between", value: [5, 10] }
 *
 * // A day on a datetime column becomes a half-open range in the column's time zone.
 * const created = { key: "createdAt", type: "datetime", filterable: true, timezone: "Europe/Istanbul" };
 * ruleToNode({ field: "createdAt", operator: "onDay", value: "2025-03-10" }, created);
 * // {
 * //   operator: "AND",
 * //   filters: [
 * //     { field: "createdAt", operator: "gte", value: "2025-03-09T21:00:00.000Z" },
 * //     { field: "createdAt", operator: "lt", value: "2025-03-10T21:00:00.000Z" },
 * //   ],
 * // }
 * ```
 */
export function ruleToNode<T>(rule: FilterRule, column: ReactDataTableColumn<T>): Filter | FilterGroup | null {
  const kind = ruleKindOf(column);
  if (!kind || rule.field !== fieldOfColumn(column)) return null;
  const field = fieldOfColumn(column);
  const { operator, value } = rule;

  if (operator === "isNull" || operator === "isNotNull") return { field, operator };

  switch (kind) {
    case "text": {
      if (!TEXT_OPERATORS.includes(operator as TextRuleOperator) || typeof value !== "string") return null;
      const term = value.trim();
      return term ? { field, operator: operator as TextRuleOperator, value: term } : null;
    }
    case "number": {
      if (operator === "between") {
        const pair = orderedPair(value, isFiniteNumber);
        return pair ? { field, operator: "between", value: pair } : null;
      }
      if (!NUMBER_OPERATORS.includes(operator as NumberRuleOperator) || !isFiniteNumber(value)) return null;
      return { field, operator: operator as Exclude<NumberRuleOperator, "between">, value };
    }
    case "date":
      return DATE_OPERATORS.includes(operator as DateRuleOperator) ? dateRuleToNode(column, rule) : null;
    case "enum": {
      if (operator !== "in" && operator !== "notIn") return null;
      if (!Array.isArray(value)) return null;
      const values = value.filter((v): v is string | number => typeof v === "string" || typeof v === "number");
      return values.length ? { field, operator, value: values } : null;
    }
    case "boolean":
      return operator === "eq" && typeof value === "boolean" ? { field, operator: "eq", value } : null;
  }
}

function isGroup(node: Filter | FilterGroup): node is FilterGroup {
  return "filters" in node;
}

function datetimeRangeToRule<T>(column: ReactDataTableColumn<T>, group: FilterGroup): FilterRule | null {
  if (group.operator !== "AND" || group.filters.length !== 2) return null;
  let start: unknown;
  let endExclusive: unknown;
  for (const child of group.filters) {
    if (isGroup(child) || child.field !== fieldOfColumn(column) || !("value" in child)) return null;
    if (child.operator === "gte" && start === undefined) start = child.value;
    else if (child.operator === "lt" && endExclusive === undefined) endExclusive = child.value;
    else return null;
  }
  const from = dayOfStart(column, start);
  const next = dayOfStart(column, endExclusive);
  if (!from || !next) return null;
  const to = addDaysToDay(next, -1);
  if (from > to) return null;
  return from === to
    ? { field: fieldOfColumn(column), operator: "onDay", value: from }
    : { field: fieldOfColumn(column), operator: "dayBetween", value: [from, to] };
}

function dateLeafToRule<T>(column: ReactDataTableColumn<T>, leaf: Filter): FilterRule | null {
  const field = fieldOfColumn(column);
  if (column.type === "datetime") {
    if (leaf.operator === "gte") {
      const day = dayOfStart(column, leaf.value);
      return day ? { field, operator: "onOrAfter", value: day } : null;
    }
    if (leaf.operator === "lt") {
      const next = dayOfStart(column, leaf.value);
      return next ? { field, operator: "onOrBefore", value: addDaysToDay(next, -1) } : null;
    }
    return null;
  }
  if (leaf.operator === "between") {
    const [from, to] = leaf.value;
    return isDay(from) && isDay(to) ? { field, operator: "dayBetween", value: [from, to] } : null;
  }
  if (!("value" in leaf) || !isDay(leaf.value)) return null;
  if (leaf.operator === "eq") return { field, operator: "onDay", value: leaf.value };
  if (leaf.operator === "gte") return { field, operator: "onOrAfter", value: leaf.value };
  if (leaf.operator === "lte") return { field, operator: "onOrBefore", value: leaf.value };
  return null;
}

/**
 * The inverse of `ruleToNode`. Returns `null` for a node the column cannot
 * represent (another field, an operator or value that does not fit the column
 * type, a `datetime` instant that is not the start of a day); the caller keeps
 * such a node as an external node. Two rules that mean the same thing can
 * compile to the same node (for example `dayBetween [d, d]` and `onDay d` on a
 * datetime column); decoding always returns the canonical one.
 *
 * @example
 * ```ts
 * const created = { key: "createdAt", type: "datetime", filterable: true, timezone: "Europe/Istanbul" };
 * const node = ruleToNode({ field: "createdAt", operator: "onDay", value: "2025-03-10" }, created);
 * nodeToRule(node!, created);
 * // { field: "createdAt", operator: "onDay", value: "2025-03-10" }
 * ```
 */
export function nodeToRule<T>(node: Filter | FilterGroup, column: ReactDataTableColumn<T>): FilterRule | null {
  const kind = ruleKindOf(column);
  if (!kind) return null;
  if (isGroup(node)) return kind === "date" && column.type === "datetime" ? datetimeRangeToRule(column, node) : null;
  if (node.field !== fieldOfColumn(column)) return null;

  const field = fieldOfColumn(column);
  if (node.operator === "isNull" || node.operator === "isNotNull") return { field, operator: node.operator };

  switch (kind) {
    case "text":
      return TEXT_OPERATORS.includes(node.operator as TextRuleOperator) && "value" in node && typeof node.value === "string"
        ? { field, operator: node.operator as TextRuleOperator, value: node.value }
        : null;
    case "number":
      if (node.operator === "between") {
        const [a, b] = node.value;
        return isFiniteNumber(a) && isFiniteNumber(b) ? { field, operator: "between", value: [a, b] } : null;
      }
      return NUMBER_OPERATORS.includes(node.operator as NumberRuleOperator) && "value" in node && isFiniteNumber(node.value)
        ? { field, operator: node.operator as NumberRuleOperator, value: node.value }
        : null;
    case "date":
      return dateLeafToRule(column, node);
    case "enum":
      return (node.operator === "in" || node.operator === "notIn") && node.value.length
        ? { field, operator: node.operator, value: [...node.value] }
        : null;
    case "boolean":
      return node.operator === "eq" && typeof node.value === "boolean" ? { field, operator: "eq", value: node.value } : null;
  }
}

/** Finds the field a node belongs to (including the single-field datetime wrapper); `null` for mixed groups. */
function fieldOf(node: Filter | FilterGroup): string | null {
  if (!isGroup(node)) return node.field;
  const first = node.filters[0];
  return first && !isGroup(first) ? first.field : null;
}

/**
 * Resolves a node into a rule using the column of the field it belongs to;
 * returns `null` for a node with no column or one that cannot be represented.
 * The filter bar and the draft of the advanced builder use the same resolution.
 * `columnsByKey` is the map produced by `columnsByField` (keyed by backend field).
 */
export function ruleOf<T>(node: Filter | FilterGroup, columnsByKey: Map<string, ReactDataTableColumn<T>>): FilterRule | null {
  const field = fieldOf(node);
  const column = field === null ? undefined : columnsByKey.get(field);
  return column ? nodeToRule(node, column) : null;
}

/**
 * Splits the applied filter tree into the entries of the bar; order is
 * preserved. If the root is not an `AND` (for example an `OR` given from
 * outside), the whole tree is a single external node, and the rules the bar adds
 * are combined with it by `AND`.
 */
export function readEntries<T>(filters: FilterGroup | null, columns: ReactDataTableColumn<T>[]): FilterEntry[] {
  if (!filters) return [];
  if (filters.operator !== "AND") return [{ type: "external", node: filters }];
  const byKey = columnsByField(columns);
  return filters.filters.map((node): FilterEntry => {
    const rule = ruleOf(node, byKey);
    return rule ? { type: "rule", rule } : { type: "external", node };
  });
}

/**
 * Entries to a new filter tree. Rules that cannot be compiled (half-finished)
 * and rules whose column is not among the given columns are skipped; external nodes stay in
 * place as they are. Returns `null` if no node is left, because an empty
 * `FilterGroup` is a 400 on the backend.
 */
export function writeEntries<T>(entries: FilterEntry[], columns: ReactDataTableColumn<T>[]): FilterGroup | null {
  const byKey = columnsByField(columns);
  const nodes: Array<Filter | FilterGroup> = [];
  for (const entry of entries) {
    if (entry.type === "external") {
      nodes.push(entry.node);
      continue;
    }
    const column = byKey.get(entry.rule.field);
    const node = column ? ruleToNode(entry.rule, column) : null;
    if (node) nodes.push(node);
  }
  return nodes.length ? { operator: "AND", filters: nodes } : null;
}
