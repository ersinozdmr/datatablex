import { describe, expect, it } from "vitest";
import type { FilterGroup } from "@datatablex/core";
import {
  excludesNulls,
  nodeToRule,
  readEntries,
  ruleOperatorsFor,
  ruleToNode,
  writeEntries,
} from "../state/filterRules.js";
import type { FilterRule } from "../state/filterRules.js";
import type { ReactDataTableColumn } from "../types.js";

interface Row {
  name: string;
  price: number;
  visitDay: string;
  accessDate: string;
  status: string;
  active: boolean;
}

const name: ReactDataTableColumn<Row> = {
  key: "name",
  title: "Name",
  type: "text",
  filterable: true,
  filterOperators: ["contains", "notContains", "eq", "isNull"],
};
const price: ReactDataTableColumn<Row> = { key: "price", title: "Price", type: "number", filterable: true };
const visitDay: ReactDataTableColumn<Row> = { key: "visitDay", title: "Day", type: "date", filterable: true };
const accessDate: ReactDataTableColumn<Row> = {
  key: "accessDate",
  title: "Time",
  type: "datetime",
  timezone: "Europe/Istanbul",
  filterable: true,
};
const status: ReactDataTableColumn<Row> = {
  key: "status",
  title: "Status",
  type: "enum",
  filterable: true,
  filterOperators: ["in", "notIn"],
  options: [
    { label: "Open", value: "open" },
    { label: "Closed", value: "closed" },
  ],
};
const active: ReactDataTableColumn<Row> = { key: "active", title: "Active", type: "boolean", filterable: true };
const columns = [name, price, visitDay, accessDate, status, active];

const roundTrip = (rule: FilterRule, column: ReactDataTableColumn<Row>) => {
  const node = ruleToNode(rule, column);
  return node ? nodeToRule(node, column) : null;
};

describe("ruleOperatorsFor", () => {
  it("without filterOperators only the operators the column menu produces today are offered", () => {
    expect(ruleOperatorsFor({ key: "t", title: "T", type: "text", filterable: true })).toEqual(["contains"]);
    expect(ruleOperatorsFor(price)).toEqual(["gte", "lte", "between"]);
    expect(ruleOperatorsFor(visitDay)).toEqual(["onOrAfter", "onOrBefore", "dayBetween"]);
    expect(ruleOperatorsFor(accessDate)).toEqual(["onDay", "onOrAfter", "onOrBefore", "dayBetween"]);
    expect(ruleOperatorsFor(active)).toEqual(["eq"]);
  });

  it("is filtered by the backend permissions; a sensitive field offers only eq/in/notIn/NULL", () => {
    expect(ruleOperatorsFor(name)).toEqual(["contains", "notContains", "eq", "isNull"]);
    const nationalId: ReactDataTableColumn<Row> = { key: "nationalId", title: "National ID", type: "text", filterable: true, filterOperators: ["eq", "in", "isNull", "isNotNull"] };
    expect(ruleOperatorsFor(nationalId)).toEqual(["eq", "isNull", "isNotNull"]);
  });

  it("datetime day rules are not offered unless gte AND lt are both open", () => {
    expect(ruleOperatorsFor({ ...accessDate, filterOperators: ["gte", "lte", "between"] })).toEqual(["onOrAfter"]);
  });

  it("a non-filterable column or an enum column without options offers no rules", () => {
    expect(ruleOperatorsFor({ ...price, filterable: false })).toEqual([]);
    expect(ruleOperatorsFor({ ...status, options: [] })).toEqual([]);
  });
});

describe("ruleToNode / nodeToRule", () => {
  it.each([
    [{ field: "name", operator: "notContains", value: "Alice" }, name],
    [{ field: "name", operator: "isNull" }, name],
    [{ field: "price", operator: "gt", value: 10 }, price],
    [{ field: "price", operator: "between", value: [10, 20] }, price],
    [{ field: "visitDay", operator: "onDay", value: "2026-01-15" }, visitDay],
    [{ field: "visitDay", operator: "dayBetween", value: ["2026-01-01", "2026-01-31"] }, visitDay],
    [{ field: "accessDate", operator: "onOrAfter", value: "2026-01-15" }, accessDate],
    [{ field: "accessDate", operator: "onOrBefore", value: "2026-01-15" }, accessDate],
    [{ field: "accessDate", operator: "dayBetween", value: ["2026-01-01", "2026-01-31"] }, accessDate],
    [{ field: "status", operator: "notIn", value: ["open"] }, status],
    [{ field: "active", operator: "eq", value: false }, active],
  ] as Array<[FilterRule, ReactDataTableColumn<Row>]>)("%o survives a round trip", (rule, column) => {
    expect(roundTrip(rule, column)).toEqual(rule);
  });

  it("a datetime day rule compiles to a half-open gte+lt group in the column's timezone", () => {
    expect(ruleToNode({ field: "accessDate", operator: "onDay", value: "2026-01-15" }, accessDate)).toEqual({
      operator: "AND",
      filters: [
        { field: "accessDate", operator: "gte", value: "2026-01-14T21:00:00.000Z" },
        { field: "accessDate", operator: "lt", value: "2026-01-15T21:00:00.000Z" },
      ],
    });
    expect(ruleToNode({ field: "accessDate", operator: "onOrBefore", value: "2026-01-15" }, accessDate)).toEqual({
      field: "accessDate",
      operator: "lt",
      value: "2026-01-15T21:00:00.000Z",
    });
  });

  it("a single-day range on datetime resolves canonically to onDay", () => {
    expect(roundTrip({ field: "accessDate", operator: "dayBetween", value: ["2026-01-15", "2026-01-15"] }, accessDate)).toEqual({
      field: "accessDate",
      operator: "onDay",
      value: "2026-01-15",
    });
  });

  it("a reversed range is put in order", () => {
    expect(ruleToNode({ field: "price", operator: "between", value: [20, 10] }, price)).toEqual({ field: "price", operator: "between", value: [10, 20] });
    expect(ruleToNode({ field: "visitDay", operator: "dayBetween", value: ["2026-02-01", "2026-01-01"] }, visitDay)).toEqual({
      field: "visitDay",
      operator: "between",
      value: ["2026-01-01", "2026-02-01"],
    });
  });

  it("an incomplete rule or one that does not fit the type is not compiled", () => {
    expect(ruleToNode({ field: "name", operator: "contains", value: "  " }, name)).toBeNull();
    expect(ruleToNode({ field: "price", operator: "gt", value: "10" }, price)).toBeNull();
    expect(ruleToNode({ field: "price", operator: "contains", value: "1" }, price)).toBeNull();
    expect(ruleToNode({ field: "status", operator: "in", value: [] }, status)).toBeNull();
    expect(ruleToNode({ field: "visitDay", operator: "onDay", value: "15.01.2026" }, visitDay)).toBeNull();
  });

  it("a datetime instant that does not fall on the start of a day is not rounded into a rule", () => {
    expect(nodeToRule({ field: "accessDate", operator: "gte", value: "2026-01-15T11:00:00.000Z" }, accessDate)).toBeNull();
  });
});

describe("readEntries / writeEntries", () => {
  it("separates rules and external nodes in order; the tree stays the same when written back", () => {
    const tree: FilterGroup = {
      operator: "AND",
      filters: [
        { field: "name", operator: "notContains", value: "Alice" },
        { operator: "OR", filters: [{ field: "price", operator: "lt", value: 5 }, { field: "price", operator: "gt", value: 50 }] },
        { field: "ghost", operator: "eq", value: 1 },
        { operator: "AND", filters: [{ field: "accessDate", operator: "gte", value: "2026-01-14T21:00:00.000Z" }, { field: "accessDate", operator: "lt", value: "2026-01-15T21:00:00.000Z" }] },
      ],
    };
    const entries = readEntries(tree, columns);
    expect(entries.map((e) => e.type)).toEqual(["rule", "external", "external", "rule"]);
    expect(writeEntries(entries, columns)).toEqual(tree);
  });

  it("an OR root is an external node as a whole; a new rule is ANDed with it", () => {
    const root: FilterGroup = { operator: "OR", filters: [{ field: "name", operator: "eq", value: "A" }] };
    const entries = readEntries(root, columns);
    expect(entries).toEqual([{ type: "external", node: root }]);
    const rule: FilterRule = { field: "price", operator: "gte", value: 3 };
    expect(writeEntries([...entries, { type: "rule", rule }], columns)).toEqual({
      operator: "AND",
      filters: [root, { field: "price", operator: "gte", value: 3 }],
    });
  });

  it("the leaf of an unfilterable column is kept as an external node", () => {
    const tree: FilterGroup = { operator: "AND", filters: [{ field: "price", operator: "gte", value: 1 }] };
    expect(readEntries(tree, [{ ...price, filterable: false }])).toEqual([{ type: "external", node: tree.filters[0] }]);
  });

  it("an incomplete rule is skipped; returns null when no node remains", () => {
    expect(writeEntries([{ type: "rule", rule: { field: "name", operator: "contains", value: "" } }], columns)).toBeNull();
    expect(readEntries(null, columns)).toEqual([]);
  });
});

describe("excludesNulls", () => {
  it("only negative operators exclude NULL rows", () => {
    expect(["neq", "notContains", "notStartsWith", "notEndsWith", "notIn"].every((op) => excludesNulls(op as FilterRule["operator"]))).toBe(true);
    expect(excludesNulls("contains")).toBe(false);
    expect(excludesNulls("isNotNull")).toBe(false);
  });
});

describe("a reversed range is corrected", () => {
  it("a number range given as [max, min] compiles as [min, max]", () => {
    expect(ruleToNode({ field: "price", operator: "between", value: [500, 100] }, price)).toEqual({ field: "price", operator: "between", value: [100, 500] });
  });

  it("a date day range given reversed is put in order", () => {
    expect(ruleToNode({ field: "visitDay", operator: "dayBetween", value: ["2026-09-10", "2026-09-01"] }, visitDay)).toEqual({
      field: "visitDay",
      operator: "between",
      value: ["2026-09-01", "2026-09-10"],
    });
  });

  it("a datetime day range given reversed produces ordered gte/lt ends", () => {
    const node = ruleToNode({ field: "accessDate", operator: "dayBetween", value: ["2026-09-10", "2026-09-01"] }, accessDate) as FilterGroup;
    const [gte, lt] = node.filters as Array<{ operator: string; value: string }>;
    expect(gte!.operator).toBe("gte");
    expect(lt!.operator).toBe("lt");
    expect(Date.parse(gte!.value)).toBeLessThan(Date.parse(lt!.value));
  });
});
