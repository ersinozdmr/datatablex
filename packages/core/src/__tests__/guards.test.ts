import { describe, expect, it } from "vitest";
import { isDataTableResultEnvelope, isFilter, isFilterGroup } from "../guards.js";

describe("isFilter", () => {
  it("accepts a scalar operator filter", () => {
    expect(isFilter({ field: "name", operator: "eq", value: "Alice" })).toBe(true);
    expect(isFilter({ field: "age", operator: "gt", value: 18 })).toBe(true);
    expect(isFilter({ field: "active", operator: "neq", value: true })).toBe(true);
  });

  it("accepts a nullary operator filter without value", () => {
    expect(isFilter({ field: "deletedAt", operator: "isNull" })).toBe(true);
    expect(isFilter({ field: "deletedAt", operator: "isNotNull" })).toBe(true);
  });

  it("accepts a between filter with a two-element tuple", () => {
    expect(isFilter({ field: "age", operator: "between", value: [1, 10] })).toBe(true);
    expect(isFilter({ field: "date", operator: "between", value: ["2026-01-01", "2026-02-01"] })).toBe(true);
  });

  it("rejects a between filter without exactly two elements", () => {
    expect(isFilter({ field: "age", operator: "between", value: [1] })).toBe(false);
    expect(isFilter({ field: "age", operator: "between", value: [1, 2, 3] })).toBe(false);
  });

  it("accepts in/notIn filters with array values", () => {
    expect(isFilter({ field: "id", operator: "in", value: [1, 2, 3] })).toBe(true);
    expect(isFilter({ field: "id", operator: "notIn", value: [] })).toBe(true);
  });

  it("rejects a scalar filter with a wrong value type", () => {
    expect(isFilter({ field: "age", operator: "gt", value: [1, 2] })).toBe(false);
    expect(isFilter({ field: "age", operator: "gt", value: { nested: true } })).toBe(false);
  });

  it("rejects malformed shapes", () => {
    expect(isFilter(null)).toBe(false);
    expect(isFilter(undefined)).toBe(false);
    expect(isFilter("eq")).toBe(false);
    expect(isFilter([])).toBe(false);
    expect(isFilter({})).toBe(false);
    expect(isFilter({ field: 1, operator: "eq", value: "x" })).toBe(false);
    expect(isFilter({ field: "x", operator: "unknownOp", value: "x" })).toBe(false);
  });
});

describe("isFilterGroup", () => {
  it("accepts a flat AND group", () => {
    expect(
      isFilterGroup({
        operator: "AND",
        filters: [
          { field: "name", operator: "contains", value: "Al" },
          { field: "age", operator: "gte", value: 18 },
        ],
      }),
    ).toBe(true);
  });

  it("accepts an empty filters array", () => {
    expect(isFilterGroup({ operator: "AND", filters: [] })).toBe(true);
  });

  it("accepts nested groups (OR of ANDs)", () => {
    expect(
      isFilterGroup({
        operator: "OR",
        filters: [
          { operator: "AND", filters: [{ field: "a", operator: "eq", value: 1 }] },
          { field: "b", operator: "isNull" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects an invalid operator", () => {
    expect(isFilterGroup({ operator: "NOT", filters: [] })).toBe(false);
  });

  it("rejects a group whose filters is not an array", () => {
    expect(isFilterGroup({ operator: "AND", filters: "nope" })).toBe(false);
  });

  it("rejects a group containing an invalid child", () => {
    expect(
      isFilterGroup({
        operator: "AND",
        filters: [{ field: "a", operator: "eq", value: 1 }, { garbage: true }],
      }),
    ).toBe(false);
  });
});

describe("isFilter / isFilterGroup — poisoned shapes", () => {
  it("a leaf cannot carry `filters` and a group cannot carry `field`/`value`", () => {
    expect(isFilter({ field: "a", operator: "eq", value: 1, filters: [] })).toBe(false);
    expect(isFilterGroup({ operator: "AND", filters: [{ field: "a", operator: "eq", value: 1, filters: [] }] })).toBe(false);
    expect(isFilterGroup({ operator: "AND", field: "a", filters: [] })).toBe(false);
    expect(isFilterGroup({ operator: "AND", value: 1, filters: [{ field: "a", operator: "isNull" }] })).toBe(false);
  });

  it("a text operator accepts only a string value", () => {
    expect(isFilter({ field: "a", operator: "contains", value: "x" })).toBe(true);
    expect(isFilter({ field: "a", operator: "contains", value: 5 })).toBe(false);
    expect(isFilter({ field: "a", operator: "notStartsWith", value: true })).toBe(false);
    expect(isFilter({ field: "a", operator: "gte", value: 5 })).toBe(true);
  });

  it("isFilterGroup does not overflow the call stack (very deep tree)", () => {
    let node: unknown = { operator: "AND", filters: [{ field: "a", operator: "isNull" }] };
    for (let i = 0; i < 50_000; i++) node = { operator: "AND", filters: [node] };
    expect(() => isFilterGroup(node)).not.toThrow();
    expect(isFilterGroup(node)).toBe(true);
  });
});
describe("isDataTableResultEnvelope", () => {
  it("accepts a valid envelope, including total: null", () => {
    expect(isDataTableResultEnvelope({ data: [{ id: 1 }], pagination: { page: 1, pageSize: 20, total: 1 } })).toBe(true);
    expect(isDataTableResultEnvelope({ data: [], pagination: { page: 2, pageSize: 20, total: null } })).toBe(true);
  });

  it.each([
    null,
    [],
    { data: "x", pagination: { page: 1, pageSize: 1, total: 0 } },
    { data: [], pagination: null },
    { data: [], pagination: { page: 0, pageSize: 1, total: 0 } },
    { data: [], pagination: { page: 1, pageSize: Number.NaN, total: 0 } },
    { data: [], pagination: { page: 1, pageSize: 1, total: 0.5 } },
    { data: [], pagination: { page: 1, pageSize: 1 } },
  ])("rejects %j", (val) => {
    expect(isDataTableResultEnvelope(val)).toBe(false);
  });
});

