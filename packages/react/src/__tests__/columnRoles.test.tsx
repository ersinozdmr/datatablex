import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DataSource, DataTableEndpointMeta, DataTableQuery } from "@datatablex/core";
import { applyEndpointMeta } from "../state/endpointMeta.js";
import { readEntries, ruleKindOf, ruleToNode, writeEntries } from "../state/filterRules.js";
import { fromDraft, toDraft } from "../state/filterDraft.js";
import { exportColumnsFor } from "../export/exportFile.js";
import { useDataTable } from "../state/useDataTable.js";
import { createLocalDataSource } from "../query/createLocalDataSource.js";
import type { ReactDataTableColumn } from "../types.js";

/**
 * Column roles: `key` is the identity, `field` is the backend field,
 * `accessor` is the displayed value. All three differ in the columns here;
 * each role is verified separately to use the right value.
 */
interface Row {
  id: number;
  code: string;
  codeMasked: string;
  first: string;
  last: string;
}

const code: ReactDataTableColumn<Row> = {
  key: "codeColumn",
  field: "code",
  accessor: "codeMasked",
  title: "Code",
  type: "text",
  filterable: true,
  sortable: true,
  filterOperators: ["eq"],
};
const fullName: ReactDataTableColumn<Row> = {
  key: "fullName",
  field: null,
  accessor: (row) => `${row.first} ${row.last}`,
  title: "Full name",
  searchable: true,
};
const id: ReactDataTableColumn<Row> = { key: "id", title: "ID", type: "number", filterable: true, sortable: true };
const columns = [id, code, fullName];

const rows: Row[] = [
  { id: 1, code: "111", codeMasked: "**1", first: "Amy", last: "Smith" },
  { id: 2, code: "222", codeMasked: "**2", first: "Ben", last: "Brown" },
];

afterEach(() => vi.restoreAllMocks());

describe("column roles — filter model", () => {
  it("the rule node uses the backend field (field)", () => {
    expect(ruleToNode({ field: "code", operator: "eq", value: "222" }, code)).toEqual({ field: "code", operator: "eq", value: "222" });
  });

  it("bar entries and the builder draft bind a node to a column by its field", () => {
    const filters = { operator: "AND" as const, filters: [{ field: "code", operator: "eq" as const, value: "222" }] };
    expect(readEntries(filters, columns)).toEqual([{ type: "rule", rule: { field: "code", operator: "eq", value: "222" } }]);
    expect(writeEntries(readEntries(filters, columns), columns)).toEqual(filters);
    expect(fromDraft(toDraft(filters, columns), columns)).toEqual(filters);
  });

  it("a field: null column is not filterable; a node written for that column stays external", () => {
    const computed = { ...fullName, filterable: true };
    expect(ruleKindOf(computed)).toBeNull();
    const external = { operator: "AND" as const, filters: [{ field: "fullName", operator: "eq" as const, value: "x" }] };
    expect(readEntries(external, [computed])[0]!.type).toBe("external");
  });
});

describe("column roles — meta and export", () => {
  const meta: DataTableEndpointMeta = {
    version: 1,
    protocol: { version: 1, supported: [1] },
    primaryKey: "id",
    limits: { maxPageSize: 500, maxFilterDepth: 3, maxFilterCount: 50, maxInValues: 500, maxSearchLength: 200, maxSortCount: 3, maxOffset: null },
    fields: {
      id: { type: "number", filterOperators: ["eq", "in", "between", "gte", "lte"], sortable: true, searchable: false },
      code: { type: "text", filterOperators: ["eq"], sortable: false, searchable: false },
    },
  };

  it("meta narrowing finds the column through field; it leaves a field: null column alone", () => {
    const { columns: narrowed, disabled } = applyEndpointMeta(columns, meta);
    expect(narrowed.find((c) => c.key === "codeColumn")).toMatchObject({ sortable: false, filterable: true, filterOperators: ["eq"] });
    expect(narrowed.find((c) => c.key === "fullName")).toBe(fullName);
    expect(disabled).toEqual(["codeColumn"]);
  });

  it("the raw export value comes from accessor (the displayed value); the column identity is key", () => {
    const state = columns.map((c, order) => ({ key: c.key, order }));
    const exported = exportColumnsFor(columns, state);
    expect(exported.map((c) => c.key)).toEqual(["id", "codeColumn", "fullName"]);
    expect(exported.map((c) => c.value(rows[1]!))).toEqual([2, "**2", "Ben Brown"]);
  });
});

describe("column roles — hook", () => {
  function recording(): { source: DataSource<Row>; queries: DataTableQuery[] } {
    const local = createLocalDataSource(rows, columns);
    const queries: DataTableQuery[] = [];
    return { queries, source: { fetch: (query, options) => (queries.push(structuredClone(query)), local.fetch(query, options)) } };
  }

  it("the sorting in the URL is validated against the backend field; column state is kept by key", async () => {
    let params = new URLSearchParams("sort=code:desc");
    const adapter = { get: () => new URLSearchParams(params), set: (next: URLSearchParams) => (params = new URLSearchParams(next)), subscribe: () => () => {} };
    const { source, queries } = recording();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: adapter }));
    await waitFor(() => expect(queries).toHaveLength(1));
    expect(queries[0]!.sorting).toEqual([{ field: "code", direction: "desc" }]);
    expect(result.current.columnState.map((c) => c.key)).toEqual(["id", "codeColumn", "fullName"]);
  });

  it("the local source search uses the accessor value, the filter uses field", async () => {
    const { source } = recording();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setSearch("ben bro"));
    await waitFor(() => expect(result.current.data.map((r) => r.id)).toEqual([2]));
    act(() => result.current.setSearch(""));
    act(() => result.current.setFilters({ operator: "AND", filters: [{ field: "code", operator: "eq", value: "111" }] }));
    await waitFor(() => expect(result.current.data.map((r) => r.id)).toEqual([1]));
  });

  it("field: null + sortable and columns sharing the same field are warned about once in dev mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { source } = recording();
    const bad = [id, { ...fullName, sortable: true }, code, { ...code, key: "codeAgain" }];
    renderHook(() => useDataTable({ dataSource: source, columns: bad, rowKey: "id" }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("Column roles")));
    const message = String(warn.mock.calls.find(([m]) => String(m).includes("Column roles"))![0]);
    expect(message).toContain('"fullName" has field: null');
    expect(message).toContain('"codeAgain" and "codeColumn" share the same field ("code")');
  });
});
