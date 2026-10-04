import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { encodeFilterParam } from "@datatablex/core";
import type { DataSource, DataTableEndpointMeta, DataTableQuery, FilterGroup } from "@datatablex/core";
import { createLocalDataSource } from "../query/createLocalDataSource.js";
import { useDataTable } from "../state/useDataTable.js";
import type { ReactDataTableColumn, UrlStateAdapter } from "../types.js";

interface Row {
  id: number;
  name: string;
  age: number;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "name", title: "Name", type: "text", searchable: true, sortable: true },
  { key: "age", title: "Age", type: "number", sortable: true },
];

const rows: Row[] = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}`, age: 20 + (i % 30) }));

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

/** In-memory adapter: records `set` calls; `navigate` imitates the back/forward button. */
function memoryAdapter(initial = "") {
  let params = new URLSearchParams(initial);
  const listeners = new Set<() => void>();
  const calls: Array<{ query: string; replace: boolean }> = [];
  const adapter: UrlStateAdapter = {
    get: () => new URLSearchParams(params),
    set: (next, options) => {
      params = new URLSearchParams(next);
      calls.push({ query: next.toString(), replace: Boolean(options?.replace) });
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    adapter,
    calls,
    current: () => params.toString(),
    navigate: (query: string) => {
      params = new URLSearchParams(query);
      listeners.forEach((listener) => listener());
    },
  };
}

const tree: FilterGroup = {
  operator: "OR",
  filters: [
    { field: "age", operator: "lt", value: 22 },
    { operator: "AND", filters: [{ field: "name", operator: "contains", value: "Row 4" }] },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("useDataTable — syncWithUrl", () => {
  it("the first query is built from the URL; no default query is sent before it and the URL is not written back", async () => {
    const url = memoryAdapter(`tab=x&page=2&pageSize=10&sort=age:desc&search=Row&f=${encodeFilterParam(tree)}`);
    const { source, queries } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: url.adapter }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(queries[0]).toEqual({
      pagination: { page: 2, pageSize: 10 },
      sorting: [{ field: "age", direction: "desc" }],
      filters: tree,
      search: "Row",
    });
    expect(result.current.search).toBe("Row");
    expect(url.calls).toEqual([]);
  });

  it("a page change is written with push, a filter change with replace; defaults and other parameters are preserved", async () => {
    const url = memoryAdapter("tab=x");
    const { source } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: url.adapter }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(url.calls).toHaveLength(1));
    expect(url.calls[0]).toEqual({ query: "tab=x&page=2", replace: false });

    const filters: FilterGroup = { operator: "AND", filters: [{ field: "age", operator: "gte", value: 30 }] };
    act(() => result.current.setFilters(filters));
    await waitFor(() => expect(url.calls).toHaveLength(2));
    expect(url.calls[1]).toEqual({ query: `tab=x&f=${encodeFilterParam(filters)}`, replace: true });
  });

  it("the back button (subscribe) applies the state from the URL and does not write back to the URL", async () => {
    const url = memoryAdapter();
    const { source, queries } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: url.adapter }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => url.navigate("page=3&sort=name:asc"));
    await waitFor(() => expect(result.current.pagination.current).toBe(3));
    expect(result.current.sorting).toEqual([{ field: "name", direction: "asc" }]);
    expect(queries.at(-1)).toMatchObject({ pagination: { page: 3, pageSize: 20 }, sorting: [{ field: "name", direction: "asc" }] });
    expect(url.calls).toEqual([]);
  });

  it("navigating to the same state sends no new query; an equivalent filter with a different child order is also equal", async () => {
    const url = memoryAdapter(`f=${encodeFilterParam(tree)}`);
    const { source, queries } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: url.adapter }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = queries.length;

    const reordered: FilterGroup = { operator: "OR", filters: [tree.filters[1]!, tree.filters[0]!] };
    act(() => url.navigate(`f=${encodeFilterParam(reordered)}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queries).toHaveLength(before);
  });

  it("a malformed f and an unsortable field are ignored; the table opens with the other parameters", async () => {
    const url = memoryAdapter("f=%%%&sort=id:asc&page=2");
    const { source, queries } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: url.adapter }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(queries[0]).toMatchObject({ pagination: { page: 2 }, sorting: [], filters: null });
    expect(result.current.error).toBeNull();
    // Invalid values are cleaned from the URL without creating a history entry.
    await waitFor(() => expect(url.current()).toBe("page=2"));
    expect(url.calls).toEqual([{ query: "page=2", replace: true }]);
  });

  it("the prefix reads and writes only its own keys", async () => {
    const url = memoryAdapter("page=9&logs.page=2");
    const { source, queries } = recordingSource();
    const { result } = renderHook(() =>
      useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: url.adapter, urlParamPrefix: "logs" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(queries[0]!.pagination.page).toBe(2);

    act(() => result.current.setSearch("Row"));
    await waitFor(() => expect(url.current()).toBe("page=9&logs.search=Row"));
  });

  it("reset() removes its own keys from the URL", async () => {
    const url = memoryAdapter("tab=x&page=2&search=Row");
    const { source } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: url.adapter }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.reset());
    await waitFor(() => expect(url.current()).toBe("tab=x"));
    expect(url.calls.at(-1)!.replace).toBe(true);
  });

  it("a custom adapter without subscribe warns once in dev", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter } = memoryAdapter();
    const { source } = recordingSource();
    renderHook(() =>
      useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: { get: adapter.get, set: adapter.set } }),
    );
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not provide `subscribe`")));
  });

  it("syncWithUrl: true uses window.history; popstate restores the state", async () => {
    window.history.replaceState(null, "", "/logs?tab=x");
    const { source } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(window.location.search).toBe("?tab=x&page=2"));
    expect(window.location.pathname).toBe("/logs");

    act(() => {
      window.history.replaceState(null, "", "/logs?tab=x&page=3");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(result.current.pagination.current).toBe(3));
  });

  it("without syncWithUrl the URL is never touched", async () => {
    window.history.replaceState(null, "", "/logs?page=5");
    const { source, queries } = recordingSource();
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(result.current.pagination.current).toBe(2));
    expect(queries[0]!.pagination.page).toBe(1);
    expect(window.location.search).toBe("?page=5");
  });
});

/** Meta that disables sorting on `age`, narrows the page size to 10 and the search to 3 characters. */
const narrowingMeta: DataTableEndpointMeta = {
  version: 1,
  protocol: { version: 1, supported: [1] },
  primaryKey: "id",
  limits: { maxPageSize: 10, maxFilterDepth: 3, maxFilterCount: 50, maxInValues: 500, maxSearchLength: 3, maxSortCount: 3, maxOffset: null },
  fields: {
    id: { type: "number", filterOperators: ["eq", "in"], sortable: false, searchable: false },
    name: { type: "text", filterOperators: ["eq", "contains"], sortable: true, searchable: true },
    age: { type: "number", filterOperators: ["eq"], sortable: false, searchable: false },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("useDataTable — syncWithUrl + late endpoint meta", () => {
  it("the first query does not wait for meta; when meta arrives, sorting/page size/search are narrowed, the query is re-sent and the URL is corrected", async () => {
    const url = memoryAdapter("pageSize=40&sort=age:desc&search=Row 4");
    const { source, queries } = recordingSource();
    const meta = deferred<DataTableEndpointMeta>();
    const dataSource: DataSource<Row> = { ...source, getMeta: () => meta.promise };
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id", syncWithUrl: url.adapter }));

    await waitFor(() => expect(queries).toHaveLength(1));
    expect(queries[0]).toMatchObject({ pagination: { pageSize: 40 }, sorting: [{ field: "age", direction: "desc" }], search: "Row 4" });

    await act(async () => meta.resolve(narrowingMeta));
    await waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]).toMatchObject({ pagination: { page: 1, pageSize: 10 }, sorting: [], search: "Row" });
    await waitFor(() => expect(url.current()).toBe("pageSize=10&search=Row"));
    expect(url.calls.every((call) => call.replace)).toBe(true);
    expect(result.current.search).toBe("Row");
  });

  it("if the query sent before meta gets a 400, normalization clears the error by itself", async () => {
    const url = memoryAdapter("sort=age:desc");
    const local = createLocalDataSource(rows, columns);
    const meta = deferred<DataTableEndpointMeta>();
    const fetch = vi.fn((query: DataTableQuery, options?: { signal?: AbortSignal }) =>
      query.sorting.some((s) => s.field === "age") ? Promise.reject(new Error("age is not sortable")) : local.fetch(query, options),
    );
    const { result } = renderHook(() => useDataTable({ dataSource: { fetch, getMeta: () => meta.promise }, columns, rowKey: "id", syncWithUrl: url.adapter }));

    await waitFor(() => expect(result.current.error?.message).toBe("age is not sortable"));
    await act(async () => meta.resolve(narrowingMeta));
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.loading).toBe(false);
    expect(result.current.sorting).toEqual([]);
  });

  it("no re-query is sent if the query already satisfies meta", async () => {
    const url = memoryAdapter("pageSize=10&sort=name:asc");
    const { source, queries } = recordingSource();
    const meta = deferred<DataTableEndpointMeta>();
    const { result } = renderHook(() =>
      useDataTable({ dataSource: { ...source, getMeta: () => meta.promise }, columns, rowKey: "id", syncWithUrl: url.adapter }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => meta.resolve(narrowingMeta));
    await act(async () => {});
    expect(queries).toHaveLength(1);
  });
});

describe("useDataTable — URL adapter that changes at runtime", () => {
  it("the URL of the new adapter is read and a single query is sent", async () => {
    const a = memoryAdapter("page=2");
    const b = memoryAdapter("page=3&sort=age:asc");
    const { source, queries } = recordingSource();
    const { result, rerender } = renderHook(({ adapter }) => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: adapter }), {
      initialProps: { adapter: a.adapter },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(queries).toHaveLength(1);

    rerender({ adapter: b.adapter });
    await waitFor(() => expect(result.current.pagination.current).toBe(3));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatchObject({ pagination: { page: 3 }, sorting: [{ field: "age", direction: "asc" }] });
    // B already carries the table state, so nothing is written back; nothing is written to A anymore either.
    expect(b.calls).toEqual([]);
    expect(a.current()).toBe("page=2");
  });

  it("an adapter passed as a new object on every render causes no loop or extra query", async () => {
    let params = new URLSearchParams("page=2");
    const makeAdapter = (): UrlStateAdapter => ({ get: () => new URLSearchParams(params), set: (next) => (params = new URLSearchParams(next)) });
    const { source, queries } = recordingSource();
    const { result, rerender } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", syncWithUrl: makeAdapter() }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender();
    rerender();
    await act(async () => {});
    expect(queries).toHaveLength(1);
    expect(result.current.pagination.current).toBe(2);
  });
});

describe("useDataTable — awaitMeta", () => {
  it("the first query waits for meta and a SINGLE request with the normalized URL state is sent", async () => {
    const url = memoryAdapter("pageSize=40&sort=age:desc&search=Row 4");
    const { source, queries } = recordingSource();
    const meta = deferred<DataTableEndpointMeta>();
    renderHook(() => useDataTable({ dataSource: { ...source, getMeta: () => meta.promise }, columns, rowKey: "id", syncWithUrl: url.adapter, awaitMeta: true }));

    await act(async () => {});
    expect(queries).toHaveLength(0);

    await act(async () => meta.resolve(narrowingMeta));
    await waitFor(() => expect(queries).toHaveLength(1));
    expect(queries[0]).toMatchObject({ pagination: { page: 1, pageSize: 10 }, sorting: [], search: "Row" });
    await act(async () => {});
    expect(queries).toHaveLength(1);
  });

  it("if meta does not arrive in time, the query uses the manually supplied limits; the table does not hang", async () => {
    const url = memoryAdapter("pageSize=40");
    const { source, queries } = recordingSource();
    renderHook(() =>
      useDataTable({ dataSource: { ...source, getMeta: () => new Promise<DataTableEndpointMeta>(() => {}) }, columns, rowKey: "id", syncWithUrl: url.adapter, awaitMeta: { timeoutMs: 30 } }),
    );
    await waitFor(() => expect(queries).toHaveLength(1));
    expect(queries[0]!.pagination.pageSize).toBe(40);
  });

  it("if meta fails, the query uses the manually supplied limits without waiting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { source, queries } = recordingSource();
    renderHook(() => useDataTable({ dataSource: { ...source, getMeta: () => Promise.reject(new Error("403")) }, columns, rowKey: "id", awaitMeta: true }));
    await waitFor(() => expect(queries).toHaveLength(1));
  });

  it("getMeta sunmayan kaynakta awaitMeta beklemez", async () => {
    const { source, queries } = recordingSource();
    renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", awaitMeta: true }));
    await waitFor(() => expect(queries).toHaveLength(1));
  });

  it("when dataSourceKey changes, the meta of the new source is awaited; no request slips out with the old meta", async () => {
    const { source, queries } = recordingSource();
    const metaB = deferred<DataTableEndpointMeta>();
    const sourceA: DataSource<Row> = { ...source, getMeta: () => Promise.resolve(narrowingMeta) };
    const sourceB: DataSource<Row> = { ...source, getMeta: () => metaB.promise };
    const { rerender } = renderHook(({ dataSource, key }) => useDataTable({ dataSource, dataSourceKey: key, columns, rowKey: "id", awaitMeta: true }), {
      initialProps: { dataSource: sourceA, key: "a" },
    });
    await waitFor(() => expect(queries).toHaveLength(1));

    rerender({ dataSource: sourceB, key: "b" });
    await act(async () => {});
    expect(queries).toHaveLength(1);

    await act(async () => metaB.resolve({ ...narrowingMeta, limits: { ...narrowingMeta.limits, maxPageSize: 5 } }));
    await waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]!.pagination.pageSize).toBe(5);
  });
});

