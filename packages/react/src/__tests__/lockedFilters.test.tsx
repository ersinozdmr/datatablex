import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFilterParam } from "@datatablex/core";
import type { DataSource, DataTableQuery, FilterGroup } from "@datatablex/core";
import { createLocalDataSource } from "../query/createLocalDataSource.js";
import { useDataTable } from "../state/useDataTable.js";
import { checkFilterTree } from "../state/filterDraft.js";
import { downloadExport } from "../export/exportFile.js";
import type { ReactDataTableColumn, UrlStateAdapter } from "../types.js";

vi.mock("../export/exportFile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../export/exportFile.js")>()),
  downloadExport: vi.fn(async () => {}),
}));

interface Row {
  id: number;
  role: string;
  age: number;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "role", title: "Role", type: "text", filterable: true },
  { key: "age", title: "Age", type: "number", filterable: true },
];

const rows: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, role: i % 2 ? "operator" : "admin", age: 20 + (i % 20) }));

function recordingSource(): { source: DataSource<Row>; queries: DataTableQuery[] } {
  const local = createLocalDataSource(rows, columns);
  const queries: DataTableQuery[] = [];
  return {
    queries,
    source: {
      fetch(query, options) {
        queries.push(structuredClone(query));
        return local.fetch(query, options);
      },
    },
  };
}

function memoryAdapter() {
  let params = new URLSearchParams();
  const adapter: UrlStateAdapter = {
    get: () => new URLSearchParams(params),
    set: (next) => {
      params = new URLSearchParams(next);
    },
    subscribe: () => () => {},
  };
  return { adapter, current: () => params };
}

const operatorOnly = (): FilterGroup => ({ operator: "AND", filters: [{ field: "role", operator: "eq", value: "operator" }] });
const adultsOver = (age: number): FilterGroup => ({ operator: "AND", filters: [{ field: "age", operator: "gte", value: age }] });
const last = (queries: DataTableQuery[]) => queries[queries.length - 1]!;

beforeEach(() => vi.mocked(downloadExport).mockClear());
afterEach(() => vi.restoreAllMocks());

describe("useDataTable — lockedFilters", () => {
  it("is ANDed with the user's filters in the query; does not enter table.filters", async () => {
    const { source, queries } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", lockedFilters: operatorOnly() }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(last(queries).filters).toEqual(operatorOnly());
    expect(result.current.filters).toBeNull();
    expect(result.current.lockedFilters).toEqual(operatorOnly());
    expect(result.current.data.every((row) => row.role === "operator")).toBe(true);

    act(() => result.current.setFilters(adultsOver(30)));
    await waitFor(() =>
      expect(last(queries).filters).toEqual({
        operator: "AND",
        filters: [
          { field: "role", operator: "eq", value: "operator" },
          { field: "age", operator: "gte", value: 30 },
        ],
      }),
    );
    expect(result.current.filters).toEqual(adultsOver(30));
  });

  it("passing a new object on every render produces no new query; when the content changes the page returns to 1", async () => {
    const { source, queries } = recordingSource();
    const { result, rerender } = renderHook(({ locked }: { locked: FilterGroup }) =>
      useDataTable({ dataSource: source, columns, rowKey: "id", lockedFilters: locked }), { initialProps: { locked: operatorOnly() } });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.pagination.onChange(1, 5));
    act(() => result.current.pagination.onChange(2, 5));
    await waitFor(() => expect(last(queries).pagination.page).toBe(2));
    const before = queries.length;

    rerender({ locked: operatorOnly() });
    rerender({ locked: operatorOnly() });
    expect(queries).toHaveLength(before);

    rerender({ locked: adultsOver(35) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The old page is never queried with the new filter: a single new request, page 1.
    expect(queries).toHaveLength(before + 1);
    expect(last(queries).pagination.page).toBe(1);
    expect(last(queries).filters).toEqual(adultsOver(35));
  });

  it("reset() and setFilters(null) do not touch the locked filter", async () => {
    const { source, queries } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", lockedFilters: operatorOnly() }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setFilters(adultsOver(30)));
    await waitFor(() => expect(result.current.filters).not.toBeNull());
    act(() => result.current.setFilters(null));
    await waitFor(() => expect(last(queries).filters).toEqual(operatorOnly()));

    act(() => result.current.setFilters(adultsOver(30)));
    act(() => result.current.reset());
    await waitFor(() => expect(result.current.filters).toBeNull());
    await waitFor(() => expect(last(queries).filters).toEqual(operatorOnly()));
  });

  it("only the user's filters are written to the URL", async () => {
    const { source } = recordingSource();
    const url = memoryAdapter();
    const { result } = renderHook(() =>
      useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: url.adapter, lockedFilters: operatorOnly() }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(url.current().has("f")).toBe(false);

    act(() => result.current.setFilters(adultsOver(30)));
    await waitFor(() => expect(url.current().has("f")).toBe(true));
    expect(decodeFilterParam(url.current().get("f")!)).toEqual(adultsOver(30));
  });

  it("allFiltered export applies the locked filter; selected export fetches only the selected keys", async () => {
    const { source, queries } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", lockedFilters: operatorOnly() }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    queries.length = 0;
    await act(async () => result.current.exportData("csv", "allFiltered"));
    expect(queries.every((q) => JSON.stringify(q.filters) === JSON.stringify(operatorOnly()))).toBe(true);
    const exported = vi.mocked(downloadExport).mock.calls[0]![2] as Row[];
    expect(exported).toHaveLength(20);

    act(() => result.current.setSelectedRowKeys([2, 4]));
    queries.length = 0;
    await act(async () => result.current.exportData("csv", "selected"));
    expect(queries[0]!.filters).toEqual({ operator: "AND", filters: [{ field: "id", operator: "in", value: [2, 4] }] });
  });

  it("an invalid or empty group is ignored and warned about in development mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { source, queries } = recordingSource();
    const { result } = renderHook(() =>
      useDataTable({ dataSource: source, columns, rowKey: "id", lockedFilters: { operator: "AND", filters: [] } }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lockedFilters).toBeNull();
    expect(last(queries).filters).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lockedFilters"));
  });
});

describe("checkFilterTree — locked filters", () => {
  it("locked leaves count against the rule budget; an AND root does not increase the depth", () => {
    const user = adultsOver(30);
    expect(checkFilterTree(user, { maxRules: 1, maxDepth: 1 })).toMatchObject({ leafCount: 1, tooManyRules: false });
    expect(checkFilterTree(user, { maxRules: 1, maxDepth: 1, locked: operatorOnly() })).toMatchObject({
      leafCount: 2,
      depth: 1,
      tooManyRules: true,
      tooDeep: false,
    });
  });
});
