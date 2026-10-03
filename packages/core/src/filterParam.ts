import { isFilter } from "./guards.js";
import type { Filter, FilterGroup } from "./types.js";

/**
 * Version of the `f` URL parameter. It is increased when the format changes;
 * `decodeFilterParam` rejects an unknown version.
 */
const FILTER_PARAM_VERSION = 1;

/**
 * Limits for `decodeFilterParam`. A URL is untrusted input: an unbounded tree
 * in `f` could overflow the stack on page load or produce a very large query.
 * The defaults are deliberately a little wider than the backend defaults
 * (depth 3, 50 leaves, 500 values): a customized backend's limits do the real
 * validation, and the goal here is only to cut off abuse early.
 */
export interface DecodeFilterParamLimits {
  /**
   * Maximum number of characters of the encoded parameter.
   *
   * @default 32768
   */
  maxLength?: number;
  /**
   * Maximum group nesting depth (the root group is 1).
   *
   * @default 16
   */
  maxDepth?: number;
  /**
   * Maximum total number of nodes (groups plus leaves).
   *
   * @default 500
   */
  maxNodes?: number;
  /**
   * Maximum number of elements in one `in`/`notIn` array.
   *
   * @default 1000
   */
  maxInValues?: number;
}

const DEFAULT_DECODE_LIMITS: Required<DecodeFilterParamLimits> = {
  maxLength: 32_768,
  maxDepth: 16,
  maxNodes: 500,
  maxInValues: 1_000,
};

function toBase64Url(bytes: Uint8Array): string {
  // `String.fromCharCode(...bytes)` can hit the argument count limit on large arrays; a loop is safe.
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Encodes a filter tree as the value of the `f` URL parameter:
 * `base64url(UTF-8(JSON({ v: 1, filters })))`.
 *
 * UTF-8 is required: a plain `btoa(JSON.stringify(...))` throws
 * `InvalidCharacterError` for characters outside latin1 such as "€" (`btoa`
 * accepts only latin1). It has no dependencies and runs in the browser and in
 * Node (>= 22), so a backend or an email template can also build a filtered
 * link to the table.
 *
 * @example
 * ```ts
 * const f = encodeFilterParam({
 *   operator: "AND",
 *   filters: [{ field: "status", operator: "eq", value: "open" }],
 * });
 * const url = `/orders?f=${f}`;
 * ```
 */
export function encodeFilterParam(filters: FilterGroup): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify({ v: FILTER_PARAM_VERSION, filters })));
}

const isObject = (val: unknown): val is Record<string, unknown> => typeof val === "object" && val !== null && !Array.isArray(val);
const isGroupNode = (val: Record<string, unknown>) => (val.operator === "AND" || val.operator === "OR") && "filters" in val;

/** Canonical copy of a leaf: only the fields the operator recognizes are carried over (extra fields are dropped). */
function canonicalLeaf(leaf: Filter): Filter {
  if (leaf.operator === "isNull" || leaf.operator === "isNotNull") return { field: leaf.field, operator: leaf.operator };
  const value = (leaf as { value?: unknown }).value;
  return { field: leaf.field, operator: leaf.operator, value: Array.isArray(value) ? [...value] : value } as Filter;
}

/**
 * Validates the tree with an explicit stack (no recursion) and builds a NEW,
 * canonical tree: depth, node count and `in` length are bounded; conflicting
 * fields such as `filters` on a leaf or `field`/`value` on a group, and unknown
 * shapes, cause the tree to be rejected.
 */
function canonicalizeTree(root: unknown, limits: Required<DecodeFilterParamLimits>): FilterGroup | null {
  if (!isObject(root) || !isGroupNode(root) || "field" in root || "value" in root || !Array.isArray(root.filters)) return null;
  const out: FilterGroup = { operator: root.operator as "AND" | "OR", filters: [] };
  const stack: Array<{ source: unknown[]; target: FilterGroup; depth: number }> = [{ source: root.filters, target: out, depth: 1 }];
  let nodes = 1;
  while (stack.length) {
    const { source, target, depth } = stack.pop()!;
    if (depth > limits.maxDepth) return null;
    for (const child of source) {
      if (++nodes > limits.maxNodes || !isObject(child)) return null;
      if (isGroupNode(child)) {
        if ("field" in child || "value" in child || !Array.isArray(child.filters)) return null;
        const group: FilterGroup = { operator: child.operator as "AND" | "OR", filters: [] };
        target.filters.push(group);
        stack.push({ source: child.filters, target: group, depth: depth + 1 });
        continue;
      }
      if (!isFilter(child)) return null;
      if ("value" in child && Array.isArray(child.value) && child.value.length > limits.maxInValues) return null;
      target.filters.push(canonicalLeaf(child));
    }
  }
  return out;
}

/**
 * The inverse of `encodeFilterParam`. A URL is untrusted input: it returns
 * `null` for malformed base64, invalid UTF-8, malformed JSON, an unknown
 * version, a shape that is not a `FilterGroup`, a tree that exceeds the limits
 * (`limits`), or an empty tree. The caller then ignores the parameter and the
 * table still opens. It does not throw for any input, including an extremely
 * deep tree. The returned tree is new and canonical. This is shape validation
 * only; authorizing fields and operators is the job of the backend allowlist.
 *
 * @example
 * ```ts
 * const filters = decodeFilterParam(new URL(location.href).searchParams.get("f") ?? "");
 * if (filters) table.setFilters(filters);
 * ```
 */
export function decodeFilterParam(value: string, limits: DecodeFilterParamLimits = {}): FilterGroup | null {
  const max = { ...DEFAULT_DECODE_LIMITS, ...limits };
  if (typeof value !== "string" || value.length > max.maxLength) return null;
  try {
    const bytes = fromBase64Url(value);
    if (!bytes) return null;
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isObject(parsed) || parsed.v !== FILTER_PARAM_VERSION) return null;
    const filters = canonicalizeTree(parsed.filters, max);
    // An empty group is a 400 on the backend and the encoder never produces one; in a hand-written link the filter is ignored too.
    return filters && filters.filters.length > 0 ? filters : null;
  } catch {
    return null;
  }
}
