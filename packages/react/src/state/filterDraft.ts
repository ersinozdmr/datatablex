import { andFilterGroups, countFilterLeaves, filterDepth } from "@datatablex/core";
import type { Filter, FilterGroup } from "@datatablex/core";
import type { ReactDataTableColumn } from "../types.js";
import { columnsByField, ruleOf, ruleToNode } from "./filterRules.js";
import type { FilterRule, RuleOperator } from "./filterRules.js";

/**
 * The draft tree of the advanced filter builder.
 *
 * A `FilterGroup` cannot be edited directly, because a draft contains states
 * that do not exist on the wire: half-finished rules, empty groups and stable
 * identifiers for React lists. The draft lives only inside the builder; "Apply"
 * produces a single `setFilters` through `fromDraft`.
 */

/** A rule that can be left half-finished in the editor: the field, the condition or the value may not be chosen yet. */
export interface DraftRuleValue {
  /** Backend field; not chosen yet when `undefined`. */
  field?: string;
  /** The condition; not chosen yet when `undefined`. */
  operator?: RuleOperator;
  /** The operand; its shape depends on `operator` (see `FilterRule`). */
  value?: unknown;
}

/** A group in the draft tree. */
export interface DraftGroup {
  /** Draft-local identifier, used as a React key; never written to the wire. */
  id: string;
  /** Discriminant of `DraftNode`. */
  type: "group";
  /** How the children of the group are combined. */
  operator: "AND" | "OR";
  /** Child rules, external nodes and sub-groups, in display order. */
  children: DraftNode[];
}

/**
 * A node of the draft tree: a group, a rule that may be incomplete, or an
 * external node. Every node carries a draft-local `id`.
 */
export type DraftNode =
  | DraftGroup
  | { id: string; type: "rule"; rule: DraftRuleValue }
  /** A leaf that cannot be resolved into a rule (unknown field, unrecognized operator or value); it is kept as it is. */
  | { id: string; type: "external"; node: Filter | FilterGroup };

let nextId = 0;

/** An identifier unique within the draft. It is only a key for React lists and is never written to the wire. */
function newId(): string {
  nextId += 1;
  return `draft-${nextId}`;
}

/** Creates a rule node with a new draft-local id; the rule is empty unless given. */
export function newRuleNode(rule: DraftRuleValue = {}): DraftNode {
  return { id: newId(), type: "rule", rule };
}

/** Creates a group node with a new draft-local id; defaults to an empty `AND` group. */
export function newGroupNode(operator: "AND" | "OR" = "AND", children: DraftNode[] = []): DraftGroup {
  return { id: newId(), type: "group", operator, children };
}

function isGroup(node: Filter | FilterGroup): node is FilterGroup {
  return "filters" in node;
}

function toDraftNode<T>(node: Filter | FilterGroup, byKey: Map<string, ReactDataTableColumn<T>>): DraftNode {
  // The rule attempt is made BEFORE the group check: the `gte` + `lt` wrapper of a
  // datetime range is a group, but for the user it is a single rule.
  const rule = ruleOf(node, byKey);
  if (rule) return newRuleNode(rule);
  if (isGroup(node)) return newGroupNode(node.operator, node.filters.map((child) => toDraftNode(child, byKey)));
  return { id: newId(), type: "external", node };
}

/**
 * Applied tree to the root group of a draft. `null` becomes an empty `AND` root.
 * A root `OR` can be represented; external nodes are only the leaves that
 * cannot be resolved into a rule, because groups themselves can always be
 * represented.
 *
 * @example
 * ```ts
 * const amount = { key: "amount", type: "number", filterable: true };
 * const draft = toDraft({ operator: "AND", filters: [{ field: "amount", operator: "gte", value: 5 }] }, [amount]);
 * // draft.operator === "AND"; draft.children[0].type === "rule"
 * fromDraft(draft, [amount]);
 * // { operator: "AND", filters: [{ field: "amount", operator: "gte", value: 5 }] }
 * ```
 */
export function toDraft<T>(filters: FilterGroup | null, columns: ReactDataTableColumn<T>[]): DraftGroup {
  if (!filters) return newGroupNode("AND");
  const byKey = columnsByField(columns);
  return newGroupNode(filters.operator, filters.filters.map((child) => toDraftNode(child, byKey)));
}

function isCompleteRule(rule: DraftRuleValue): rule is FilterRule {
  return rule.field !== undefined && rule.operator !== undefined;
}

function compileRule<T>(rule: DraftRuleValue, byKey: Map<string, ReactDataTableColumn<T>>): Filter | FilterGroup | null {
  if (!isCompleteRule(rule)) return null;
  const column = byKey.get(rule.field);
  return column ? ruleToNode(rule, column) : null;
}

function compileGroup<T>(group: DraftGroup, byKey: Map<string, ReactDataTableColumn<T>>): FilterGroup | null {
  const filters: Array<Filter | FilterGroup> = [];
  for (const child of group.children) {
    const node =
      child.type === "group" ? compileGroup(child, byKey) : child.type === "rule" ? compileRule(child.rule, byKey) : child.node;
    if (node) filters.push(node);
  }
  // An empty group carries no meaning and is a 400 on the backend; a group with a
  // single child is the structure the user built and is not silently flattened.
  return filters.length ? { operator: group.operator, filters } : null;
}

/**
 * Draft to wire tree. Empty groups are dropped. Half-finished rules are also
 * skipped, but the builder catches them with `validateDraft` and blocks "Apply",
 * so the applied filter never silently differs from what the user sees.
 * Returns `null` when nothing compiles.
 */
export function fromDraft<T>(root: DraftGroup, columns: ReactDataTableColumn<T>[]): FilterGroup | null {
  return compileGroup(root, columnsByField(columns));
}

/** The limits a filter tree is checked against; they mirror the backend limits. */
export interface DraftLimits {
  /** Maximum number of leaf filters (the backend `maxFilterCount`). */
  maxRules: number;
  /** Maximum group nesting depth (the backend `maxFilterDepth`). */
  maxDepth: number;
  /**
   * The table's locked filters (`table.lockedFilters`). The backend counts the
   * combined tree; the check also combines the tree with this by `AND`, so the
   * locked leaves are subtracted from the user's rule budget.
   */
  locked?: FilterGroup | null;
}

/** The result of `checkFilterTree`. */
export interface FilterTreeCheck {
  /** Number of leaf filters in the combined tree. */
  leafCount: number;
  /** Group nesting depth of the combined tree. */
  depth: number;
  /** `leafCount` exceeds `maxRules`. */
  tooManyRules: boolean;
  /** `depth` exceeds `maxDepth`. */
  tooDeep: boolean;
}

/**
 * Checks the leaf count and depth limits of the tree about to be applied. The
 * simple bar and the advanced builder use the SAME check. Depth matters in the
 * simple bar too: a datetime "on this day" rule compiles into a `gte` + `lt`
 * group, so a single visual rule also adds a level of depth, and with
 * `maxFilterDepth: 1` the backend would answer 400. The count is taken on the
 * tree that goes into the query: combined with the locked filters, if any.
 */
export function checkFilterTree(tree: FilterGroup | null, limits: DraftLimits): FilterTreeCheck {
  const combined = andFilterGroups(limits.locked, tree);
  const leafCount = countFilterLeaves(combined);
  const depth = filterDepth(combined);
  return { leafCount, depth, tooManyRules: leafCount > limits.maxRules, tooDeep: depth > limits.maxDepth };
}

/** The result of `validateDraft`: everything the builder needs to enable or block "Apply". */
export interface DraftValidation {
  /** Ids of the missing or invalid rules; rows are highlighted with them. */
  incomplete: string[];
  /** Number of leaf filters in the compiled tree, including locked filters. */
  leafCount: number;
  /** Group nesting depth of the compiled tree, including locked filters. */
  depth: number;
  /** `leafCount` exceeds `limits.maxRules`. */
  tooManyRules: boolean;
  /** `depth` exceeds `limits.maxDepth`. */
  tooDeep: boolean;
  /** `true` when there are no incomplete rules and neither limit is exceeded. */
  valid: boolean;
}

function collectIncomplete<T>(group: DraftGroup, byKey: Map<string, ReactDataTableColumn<T>>, out: string[]): void {
  for (const child of group.children) {
    if (child.type === "group") collectIncomplete(child, byKey, out);
    else if (child.type === "rule" && !compileRule(child.rule, byKey)) out.push(child.id);
  }
}

/**
 * The state of "Apply". Counts are taken on the COMPILED tree, not on the draft:
 * a datetime "on this day" / "between dates" rule compiles into a `gte` + `lt`
 * wrapper, so it counts as two leaves and one level of depth, which is also how
 * the backend counts.
 */
export function validateDraft<T>(root: DraftGroup, columns: ReactDataTableColumn<T>[], limits: DraftLimits): DraftValidation {
  const byKey = columnsByField(columns);
  const incomplete: string[] = [];
  collectIncomplete(root, byKey, incomplete);
  const check = checkFilterTree(compileGroup(root, byKey), limits);
  return { incomplete, ...check, valid: !incomplete.length && !check.tooManyRules && !check.tooDeep };
}

/** The level of a group in the draft (root = 1); `null` if it is not found. Whether "Add group" is disabled depends on this. */
export function groupDepth(root: DraftGroup, groupId: string, level = 1): number | null {
  if (root.id === groupId) return level;
  for (const child of root.children) {
    if (child.type !== "group") continue;
    const found = groupDepth(child, groupId, level + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Replaces the node with the given `id` by what `update` returns (`null` deletes it); if nothing changes, the same reference is returned. */
function mapNode(group: DraftGroup, id: string, update: (node: DraftNode) => DraftNode | DraftNode[] | null): DraftGroup {
  let changed = false;
  const children: DraftNode[] = [];
  for (const child of group.children) {
    if (child.id === id) {
      changed = true;
      const next = update(child);
      if (Array.isArray(next)) children.push(...next);
      else if (next) children.push(next);
      continue;
    }
    if (child.type === "group") {
      const next = mapNode(child, id, update);
      if (next !== child) changed = true;
      children.push(next);
      continue;
    }
    children.push(child);
  }
  return changed ? { ...group, children } : group;
}

/** Inserts `node` into the group `parentId` at `index` (at the end if not given). Returns a new root; the same root if the group is not found. */
export function insertNode(root: DraftGroup, parentId: string, node: DraftNode, index?: number): DraftGroup {
  const add = (group: DraftGroup): DraftGroup => {
    const children = [...group.children];
    children.splice(index ?? children.length, 0, node);
    return { ...group, children };
  };
  if (root.id === parentId) return add(root);
  return mapNode(root, parentId, (group) => (group.type === "group" ? add(group) : group));
}

/** Removes the node with the given id; returns the same root if it is not found. */
export function removeNode(root: DraftGroup, id: string): DraftGroup {
  return mapNode(root, id, () => null);
}

/** Replaces the node with the given id by `node`; returns the same root if it is not found. */
export function replaceNode(root: DraftGroup, id: string, node: DraftNode): DraftGroup {
  return mapNode(root, id, () => node);
}

/** Sets the `AND`/`OR` operator of a group (the root included); returns the same root if the group is not found. */
export function setGroupOperator(root: DraftGroup, groupId: string, operator: "AND" | "OR"): DraftGroup {
  if (root.id === groupId) return { ...root, operator };
  return mapNode(root, groupId, (group) => (group.type === "group" ? { ...group, operator } : group));
}

function cloneWithNewIds(node: DraftNode): DraftNode {
  if (node.type === "group") return { ...node, id: newId(), children: node.children.map(cloneWithNewIds) };
  return { ...node, id: newId() };
}

/** Inserts a copy of the node (with its whole subtree if it is a group) with new ids right after it. */
export function duplicateNode(root: DraftGroup, id: string): DraftGroup {
  return mapNode(root, id, (node) => [node, cloneWithNewIds(node)]);
}
