import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DataSource, DataTableEndpointMeta, DataTableFieldOption, DataTableQuery, FilterGroup } from "@datatablex/core";
import { applyEndpointMeta } from "../state/endpointMeta.js";
import { readEntries, ruleKindOf, ruleOperatorsFor } from "../state/filterRules.js";
import { useDataTable } from "../state/useDataTable.js";
import { createRestDataSource } from "../query/createRestDataSource.js";
import type { ReactDataTableColumn } from "../types.js";

interface Row {
  id: number;
  status: string;
  kind: string;
}

const meta: DataTableEndpointMeta = {
  version: 1,
  protocol: { version: 1, supported: [1] },
  primaryKey: "id",
  limits: { maxPageSize: 500, maxFilterDepth: 3, maxFilterCount: 50, maxInValues: 500, maxSearchLength: 200, maxSortCount: 3, maxOffset: null },
  fields: {
    id: { type: "number", filterOperators: ["eq", "in"], sortable: false, searchable: false },
    status: { type: "enum", filterOperators: ["in", "notIn"], sortable: false, searchable: false, hasOptions: true },
    kind: { type: "enum", filterOperators: ["in"], sortable: false, searchable: false, hasOptions: true },
  },
};

const MANUAL = [{ label: "Manual", value: "manual" }];
const SERVER: DataTableFieldOption[] = [
  { label: "Open", value: "open" },
  { label: "Closed", value: "closed" },
];

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "status", title: "Status", type: "enum", filterable: true },
  { key: "kind", title: "Kind", type: "enum", filterable: true, options: MANUAL },
];

const statusFilter: FilterGroup = { operator: "AND", filters: [{ field: "status", operator: "in", value: ["open"] }] };

function source(getOptions: (field: string, options?: { signal?: AbortSignal }) => Promise<DataTableFieldOption[]>) {
  return {
    fetch: vi.fn(async (query: DataTableQuery) => ({ data: [] as Row[], pagination: { page: 1, pageSize: query.pagination.pageSize, total: 0 } })),
    getMeta: vi.fn(() => Promise.resolve(meta)),
    getOptions: vi.fn(getOptions),
  } satisfies DataSource<Row>;
}

const column = (cols: ReactDataTableColumn<Row>[], key: string) => cols.find((c) => c.key === key)!;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ruleKindOf — server options", () => {
  const base: ReactDataTableColumn<Row> = { key: "status", title: "Status", type: "enum", filterable: true };

  it("a column awaiting options carries an enum rule; an empty list and an error do not", () => {
    expect(ruleKindOf(base)).toBeNull();
    expect(ruleKindOf({ ...base, optionsState: "idle" })).toBe("enum");
    expect(ruleKindOf({ ...base, optionsState: "loading" })).toBe("enum");
    expect(ruleKindOf({ ...base, optionsState: "ready", options: SERVER })).toBe("enum");
    expect(ruleKindOf({ ...base, optionsState: "ready", options: [] })).toBeNull();
    expect(ruleKindOf({ ...base, optionsState: "error", options: [] })).toBeNull();
    expect(ruleKindOf({ ...base, optionsState: "idle", filterable: false })).toBeNull();
  });
});

describe("applyEndpointMeta — hasOptions", () => {
  it("turns an enum column without manual options idle; a manually supplied list takes precedence", () => {
    const { columns: narrowed, disabled } = applyEndpointMeta(columns, meta, true);
    expect(column(narrowed, "status")).toMatchObject({ filterable: true, optionsState: "idle" });
    expect(ruleOperatorsFor(column(narrowed, "status"))).toEqual(["in", "notIn"]);
    expect(column(narrowed, "kind").optionsState).toBeUndefined();
    expect(column(narrowed, "kind").options).toBe(MANUAL);
    expect(disabled).toEqual([]);
  });

  it("a manually supplied empty list also takes precedence (the column stays unfilterable)", () => {
    const { columns: narrowed } = applyEndpointMeta([{ ...columns[1]!, options: [] }], meta, true);
    expect(narrowed[0]).toMatchObject({ filterable: false });
    expect(narrowed[0]!.optionsState).toBeUndefined();
  });

  it("does not widen the capability: a non-filterable column stays disabled", () => {
    const { columns: narrowed } = applyEndpointMeta([{ key: "status", title: "Status", type: "enum" }], meta, true);
    expect(ruleKindOf(narrowed[0]!)).toBeNull();
  });

  it("behaves as before when the DataSource offers no getOptions or the meta does not report hasOptions", () => {
    expect(column(applyEndpointMeta(columns, meta).columns, "status")).toMatchObject({ filterable: false });
    const plain = { ...meta, fields: { ...meta.fields, status: { ...meta.fields.status!, hasOptions: false } } };
    expect(column(applyEndpointMeta(columns, plain, true).columns, "status")).toMatchObject({ filterable: false });
  });
});

describe("useDataTable — server options", () => {
  it("is lazy: sends no request initially, fetches once through loadOptions and writes to the column", async () => {
    const dataSource = source(() => Promise.resolve(SERVER));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("idle"));
    expect(dataSource.getOptions).not.toHaveBeenCalled();

    act(() => result.current.loadOptions!("status"));
    expect(column(result.current.columns, "status").optionsState).toBe("loading");
    act(() => result.current.loadOptions!("status"));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("ready"));
    expect(column(result.current.columns, "status").options).toEqual(SERVER);
    act(() => result.current.loadOptions!("status"));
    expect(dataSource.getOptions).toHaveBeenCalledTimes(1);
    expect(dataSource.getOptions).toHaveBeenCalledWith("status", { signal: expect.any(AbortSignal) });
  });

  it("sends no request for a field with manual options or one that awaits no options", async () => {
    const dataSource = source(() => Promise.resolve(SERVER));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("idle"));
    act(() => {
      result.current.loadOptions!("kind");
      result.current.loadOptions!("id");
      result.current.loadOptions!("ghost");
    });
    expect(dataSource.getOptions).not.toHaveBeenCalled();
    expect(column(result.current.columns, "kind").options).toBe(MANUAL);
  });

  it("fetches the options of a column with an active rule automatically once the meta arrives", async () => {
    const dataSource = source(() => Promise.resolve(SERVER));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    act(() => result.current.setFilters(statusFilter));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("ready"));
    expect(dataSource.getOptions).toHaveBeenCalledTimes(1);
    expect(readEntries(result.current.filters, result.current.columns)).toEqual([{ type: "rule", rule: { field: "status", operator: "in", value: ["open"] } }]);
  });

  it("loads the options of an active rule in StrictMode as well", async () => {
    const dataSource = source(() => Promise.resolve(SERVER));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }), { wrapper: StrictMode });
    act(() => result.current.setFilters(statusFilter));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("ready"));
  });

  it("an empty list disables only the filter of that column", async () => {
    const dataSource = source(() => Promise.resolve([]));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("idle"));
    act(() => result.current.loadOptions!("status"));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("ready"));
    expect(column(result.current.columns, "status")).toMatchObject({ filterable: false, options: [] });
    expect(column(result.current.columns, "kind").filterable).toBe(true);
  });

  it("an error disables the column, keeps the rule as an external node, does not break the table; loadOptions retries", async () => {
    let fail = true;
    const dataSource = source(() => (fail ? Promise.reject(new Error("500")) : Promise.resolve(SERVER)));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    act(() => result.current.setFilters(statusFilter));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("error"));
    expect(column(result.current.columns, "status").filterable).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.filters).toEqual(statusFilter);
    expect(readEntries(result.current.filters, result.current.columns)).toEqual([{ type: "external", node: statusFilter.filters[0] }]);
    // No automatic retry (no loop).
    expect(dataSource.getOptions).toHaveBeenCalledTimes(1);

    fail = false;
    act(() => result.current.loadOptions!("status"));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("ready"));
    expect(column(result.current.columns, "status").filterable).toBe(true);
  });

  it("resets the options and requests them again when dataSourceKey changes", async () => {
    const dataSource = source(() => Promise.resolve(SERVER));
    const { result, rerender } = renderHook(({ k }) => useDataTable({ dataSource, dataSourceKey: k, columns, rowKey: "id" }), { initialProps: { k: "a" } });
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("idle"));
    act(() => result.current.loadOptions!("status"));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("ready"));

    rerender({ k: "b" });
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("idle"));
    act(() => result.current.loadOptions!("status"));
    await waitFor(() => expect(column(result.current.columns, "status").optionsState).toBe("ready"));
    expect(dataSource.getOptions).toHaveBeenCalledTimes(2);
  });

  it("a column stays unfilterable on a source that offers no getOptions", async () => {
    const full = source(() => Promise.resolve(SERVER));
    const dataSource: DataSource<Row> = { fetch: full.fetch, getMeta: full.getMeta };
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.columns).not.toBe(columns));
    expect(column(result.current.columns, "status")).toMatchObject({ filterable: false });
    expect(column(result.current.columns, "status").optionsState).toBeUndefined();
    expect(result.current.loadOptions).toBeUndefined();
  });
});

describe("createRestDataSource — getOptions", () => {
  const json = (body: unknown, init: { ok?: boolean; status?: number } = {}) => ({ ok: init.ok ?? true, status: init.status ?? 200, json: () => Promise.resolve(body) }) as Response;
  const body = { version: 1, options: SERVER };

  it("is undefined when there is neither metaEndpoint nor optionsEndpoint, or when optionsEndpoint is false", () => {
    expect(createRestDataSource({ endpoint: "/q" }).getOptions).toBeUndefined();
    expect(createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta", optionsEndpoint: false }).getOptions).toBeUndefined();
  });

  it("the default address is ${endpoint}/options/<field>; sends a GET with the headers and the protocol header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(body));
    vi.stubGlobal("fetch", fetchMock);
    const ds = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta", headers: { authorization: "Bearer t" } });
    await expect(ds.getOptions!("status/code")).resolves.toEqual(SERVER);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/q/options/status%2Fcode");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ authorization: "Bearer t", "x-datatablex-protocol": "1" });
  });

  it("an explicit optionsEndpoint is used", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(body));
    vi.stubGlobal("fetch", fetchMock);
    await createRestDataSource({ endpoint: "/q", optionsEndpoint: "/choices" }).getOptions!("status");
    expect(fetchMock.mock.calls[0]![0]).toBe("/choices/status");
  });

  it("fetches once per field; invalidateOptions(field) and invalidateMeta clear the cache", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(body)));
    vi.stubGlobal("fetch", fetchMock);
    const ds = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta" });
    await ds.getOptions!("status");
    await ds.getOptions!("status");
    await ds.getOptions!("kind");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    ds.invalidateOptions!("status");
    await ds.getOptions!("status");
    await ds.getOptions!("kind");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    ds.invalidateMeta!();
    await ds.getOptions!("status");
    await ds.getOptions!("kind");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("a failed request is not cached; a malformed body and an unknown version are rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "x", code: "options_too_large" }, { ok: false, status: 500 }))
      .mockResolvedValueOnce(json(SERVER))
      .mockResolvedValueOnce(json({ version: 2, options: [] }))
      .mockResolvedValue(json(body));
    vi.stubGlobal("fetch", fetchMock);
    const ds = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta" });
    await expect(ds.getOptions!("status")).rejects.toMatchObject({ name: "DataTableRequestError", status: 500, code: "options_too_large" });
    await expect(ds.getOptions!("status")).rejects.toThrow(/did not return a recognized option list/);
    await expect(ds.getOptions!("status")).rejects.toThrow(/did not return a recognized option list/);
    await expect(ds.getOptions!("status")).resolves.toEqual(SERVER);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("one caller's abort does not cut the shared request", async () => {
    let release = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (release = () => resolve(json(body))))));
    const ds = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta" });
    const controller = new AbortController();
    const aborted = ds.getOptions!("status", { signal: controller.signal });
    const kept = ds.getOptions!("status");
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => release());
    release();
    await expect(kept).resolves.toEqual(SERVER);
  });
});
