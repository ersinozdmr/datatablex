import type { Filter, FilterGroup } from "./types.js";

function isGroup(node: Filter | FilterGroup): node is FilterGroup {
  return "filters" in node;
}

function canonicalValue(value: unknown): string {
  return Array.isArray(value) ? `[${value.map(canonicalValue).join(",")}]` : JSON.stringify(value);
}

/**
 * Separator placed between the field name and the operator. A character is
 * chosen that is not expected to appear in the data (field name, operator), so
 * that two different leaves such as `"a b" eq` and `"a" "b eq"` do not produce
 * the same key. It is written as an escape sequence instead of a LITERAL NUL
 * byte in the source, because a literal NUL makes `grep`, `file` and some diff
 * tools treat the file as binary.
 */
const SEP = "\u0000";

/**
 * Reduces a leaf or a group to a single string key that does not depend on the
 * ORDER of the children. The children of `AND`/`OR` are logically unordered
 * (`AND(A,B)` is equivalent to `AND(B,A)`); the child keys are sorted before
 * being joined, so duplicates are kept (multiset semantics) and only the order
 * is discarded.
 */
export function canonicalFilterKey(node: Filter | FilterGroup): string {
  if (isGroup(node)) {
    const childKeys = node.filters.map(canonicalFilterKey).sort();
    return `G(${node.operator}:${childKeys.join("|")})`;
  }
  const value = "value" in node ? node.value : undefined;
  return `L(${node.field}${SEP}${node.operator}${SEP}${canonicalValue(value)})`;
}

/**
 * LOGICAL equality of two filter trees: insensitive to the order of children,
 * sensitive to the number of duplicates. Any UI that rebuilds the filter tree
 * (column menu, filter builder, URL sync) answers "did it really change" with
 * this function; writing an equivalent tree to `setFilters` would reset the
 * page to 1 needlessly.
 *
 * @example
 * ```ts
 * const a: Filter = { field: "name", operator: "contains", value: "al" };
 * const b: Filter = { field: "age", operator: "gte", value: 18 };
 * filtersEqual({ operator: "AND", filters: [a, b] }, { operator: "AND", filters: [b, a] }); // true
 * filtersEqual({ operator: "AND", filters: [a, a, b] }, { operator: "AND", filters: [a, b] }); // false
 * ```
 */
export function filtersEqual(a: FilterGroup | null, b: FilterGroup | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return canonicalFilterKey(a) === canonicalFilterKey(b);
}

/**
 * Number of leaf `Filter`s in the tree, counted the same way as the backend
 * `maxFilterCount`. Groups, such as the `gte` + `lt` wrapper of a datetime
 * range, are counted only through their leaves. `null` (no filter) is 0.
 */
export function countFilterLeaves(node: Filter | FilterGroup | null): number {
  if (!node) return 0;
  return isGroup(node) ? node.filters.reduce((sum, child) => sum + countFilterLeaves(child), 0) : 1;
}

/**
 * Group nesting depth, counted the same way as the backend `maxFilterDepth`: a
 * single group is 1, each sub-group adds one level; a leaf and `null` are 0.
 * The datetime range wrapper is also a group and adds one level.
 */
export function filterDepth(node: Filter | FilterGroup | null): number {
  if (!node || !isGroup(node)) return 0;
  return 1 + node.filters.reduce((max, child) => Math.max(max, filterDepth(child)), 0);
}

/**
 * Combines two filter trees with `AND`; this is how locked (host) filters and
 * the user's filters are sent in the query. The children of a side whose root
 * is `AND` are flattened: `AND(AND(a, b), AND(c))` is equivalent to
 * `AND(a, b, c)`, which has the same meaning and does not increase the depth
 * needlessly. An empty or missing side is ignored; if both are missing it
 * returns `null` (an empty group is a 400 on the backend).
 */
export function andFilterGroups(a: FilterGroup | null | undefined, b: FilterGroup | null | undefined): FilterGroup | null {
  const left = a?.filters.length ? a : null;
  const right = b?.filters.length ? b : null;
  if (!left || !right) return left ?? right;
  const children = (group: FilterGroup) => (group.operator === "AND" ? group.filters : [group]);
  return { operator: "AND", filters: [...children(left), ...children(right)] };
}
