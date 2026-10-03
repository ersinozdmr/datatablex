import { describe, expect, it } from "vitest";
import type { Filter, FilterGroup } from "../types.js";
import { andFilterGroups, canonicalFilterKey, countFilterLeaves, filterDepth, filtersEqual } from "../filterTree.js";

describe("filtersEqual — logical equality of filter trees", () => {
  it("null equals null, null does not equal a non-empty group", () => {
    expect(filtersEqual(null, null)).toBe(true);
    expect(filtersEqual(null, { operator: "AND", filters: [{ field: "a", operator: "isNull" }] })).toBe(false);
  });

  it("DIFFERENT objects with the same content are equal (value comparison, not reference)", () => {
    const a: FilterGroup = { operator: "AND", filters: [{ field: "amount", operator: "between", value: [1, 2] }] };
    const b: FilterGroup = { operator: "AND", filters: [{ field: "amount", operator: "between", value: [1, 2] }] };
    expect(filtersEqual(a, b)).toBe(true);
  });

  it("detects a difference in value, operator, group operator and depth", () => {
    const base: FilterGroup = { operator: "AND", filters: [{ field: "amount", operator: "between", value: [1, 2] }] };
    expect(filtersEqual(base, { operator: "AND", filters: [{ field: "amount", operator: "between", value: [1, 3] }] })).toBe(false);
    expect(filtersEqual(base, { operator: "AND", filters: [{ field: "amount", operator: "gte", value: 1 }] })).toBe(false);
    expect(filtersEqual(base, { operator: "OR", filters: [{ field: "amount", operator: "between", value: [1, 2] }] })).toBe(false);
    expect(
      filtersEqual(base, { operator: "AND", filters: [{ operator: "AND", filters: [{ field: "amount", operator: "between", value: [1, 2] }] }] }),
    ).toBe(false);
  });

  it("nested groups are compared recursively", () => {
    const nested = (): FilterGroup => ({
      operator: "AND",
      filters: [{ operator: "OR", filters: [{ field: "name", operator: "contains", value: "a" }] }],
    });
    expect(filtersEqual(nested(), nested())).toBe(true);
  });

  it("is insensitive to CHILD ORDER — a different order (for example from column reordering or programmatic changes) is equivalent", () => {
    const nameLeaf: Filter = { field: "name", operator: "contains", value: "alice" };
    const statusLeaf: Filter = { field: "status", operator: "in", value: ["open"] };
    const forward: FilterGroup = { operator: "AND", filters: [nameLeaf, statusLeaf] };
    const reordered: FilterGroup = { operator: "AND", filters: [statusLeaf, nameLeaf] };
    expect(filtersEqual(forward, reordered)).toBe(true);

    // The same holds for OR.
    const orA: FilterGroup = { operator: "OR", filters: [nameLeaf, statusLeaf] };
    const orB: FilterGroup = { operator: "OR", filters: [statusLeaf, nameLeaf] };
    expect(filtersEqual(orA, orB)).toBe(true);
  });

  it("multiset semantics are kept — duplicates are order-independent but must match in COUNT", () => {
    const leaf: Filter = { field: "amount", operator: "gte", value: 1 };
    const other: Filter = { field: "amount", operator: "lte", value: 9 };
    const twoAndOne: FilterGroup = { operator: "AND", filters: [leaf, leaf, other] };
    const oneAndTwo: FilterGroup = { operator: "AND", filters: [other, leaf, leaf] };
    expect(filtersEqual(twoAndOne, oneAndTwo)).toBe(true);

    const onlyOneRepeat: FilterGroup = { operator: "AND", filters: [leaf, other] };
    expect(filtersEqual(twoAndOne, onlyOneRepeat)).toBe(false);
  });
});

describe("canonicalFilterKey", () => {
  it("a collision cannot be produced by shifting the boundary between field name and operator", () => {
    const a: Filter = { field: "a b", operator: "eq", value: 1 };
    const b = { field: "a", operator: "b eq", value: 1 } as unknown as Filter;
    expect(canonicalFilterKey(a)).not.toBe(canonicalFilterKey(b));
  });
});

describe("countFilterLeaves / filterDepth", () => {
  const range: FilterGroup = {
    operator: "AND",
    filters: [
      { field: "at", operator: "gte", value: "2026-01-01T00:00:00Z" },
      { field: "at", operator: "lt", value: "2026-01-02T00:00:00Z" },
    ],
  };
  const tree: FilterGroup = {
    operator: "AND",
    filters: [
      { field: "a", operator: "eq", value: 1 },
      { operator: "OR", filters: [{ field: "b", operator: "isNull" }, range] },
    ],
  };

  it("counts leaves the same way as the backend", () => {
    expect(countFilterLeaves(tree)).toBe(4);
    expect(countFilterLeaves({ field: "a", operator: "eq", value: 1 })).toBe(1);
    expect(countFilterLeaves(null)).toBe(0);
  });

  it("a single group has depth 1 and the datetime wrapper adds one level", () => {
    expect(filterDepth({ operator: "AND", filters: [{ field: "a", operator: "eq", value: 1 }] })).toBe(1);
    expect(filterDepth(tree)).toBe(3);
    expect(filterDepth(null)).toBe(0);
    expect(filterDepth({ field: "a", operator: "eq", value: 1 })).toBe(0);
  });
});

describe("andFilterGroups", () => {
  const a = { field: "a", operator: "eq" as const, value: 1 };
  const b = { field: "b", operator: "eq" as const, value: 2 };
  const c = { field: "c", operator: "eq" as const, value: 3 };

  it("merges two AND roots by flattening them; the depth does not increase", () => {
    const merged = andFilterGroups({ operator: "AND", filters: [a] }, { operator: "AND", filters: [b, c] });
    expect(merged).toEqual({ operator: "AND", filters: [a, b, c] });
    expect(filterDepth(merged)).toBe(1);
  });

  it("an OR root becomes a child as a whole", () => {
    const or = { operator: "OR" as const, filters: [b, c] };
    expect(andFilterGroups({ operator: "AND", filters: [a] }, or)).toEqual({ operator: "AND", filters: [a, or] });
    expect(andFilterGroups(or, null)).toBe(or);
  });

  it("a missing or empty side is ignored; null when both are missing", () => {
    const g = { operator: "AND" as const, filters: [a] };
    expect(andFilterGroups(g, null)).toBe(g);
    expect(andFilterGroups(undefined, g)).toBe(g);
    expect(andFilterGroups({ operator: "AND", filters: [] }, g)).toBe(g);
    expect(andFilterGroups(null, undefined)).toBeNull();
  });
});
