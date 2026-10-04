import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DataSource, DataTableEndpointMeta, DataTableQuery } from "@datatablex/core";
import { applyEndpointMeta } from "../state/endpointMeta.js";
import { useDataTable } from "../state/useDataTable.js";
import type { ReactDataTableColumn } from "../types.js";

vi.mock("../export/exportFile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../export/exportFile.js")>()),
  downloadExport: vi.fn(async () => {}),
}));

interface Row {
  id: number;
  name: string;
  price: number;
  nationalId: string;
}

const meta: DataTableEndpointMeta = {
  version: 1,
  protocol: { version: 1, supported: [1] },
  primaryKey: "id",
  limits: {
    maxPageSize: 500,
    maxFilterDepth: 3,
    maxFilterCount: 50,
    maxInValues: 2,
    maxSearchLength: 5,
    maxSortCount: 3,
    maxOffset: null,
  },
  fields: {
    id: { type: "number", filterOperators: ["eq", "in"], sortable: false, searchable: false },
    name: { type: "text", filterOperators: ["eq", "contains"], sortable: true, searchable: true },
    price: { type: "number", filterOperators: ["gte", "lte"], sortable: false, searchable: false },
    nationalId: { type: "text", filterOperators: ["eq"], sortable: false, searchable: false },
  },
};

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "name", title: "Name", type: "text", filterable: true, sortable: true },
  { key: "price", title: "Price", type: "number", filterable: true, sortable: true },
  { key: "nationalId", title: "National ID", type: "text", filterable: true },
  { key: "computed", title: "Computed", type: "text", filterable: true, sortable: true },
];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyEndpointMeta", () => {
  const byKey = (cols: ReactDataTableColumn<Row>[]) => new Map(cols.map((c) => [c.key, c]));

  it("disables the capabilities the backend does not allow and keeps the ones it does", () => {
    const { columns: narrowed, disabled } = applyEndpointMeta(columns, meta);
    const cols = byKey(narrowed);

    expect(cols.get("name")).toMatchObject({ filterable: true, sortable: true, filterOperators: ["eq", "contains"] });
    // The bar offers only the rules of the open operators: gte/lte are enough, `between` is not offered.
    expect(cols.get("price")).toMatchObject({ filterable: true, sortable: false, filterOperators: ["gte", "lte"] });
    // Sensitive field: even if the column names no operators, the text box narrows to `eq`.
    expect(cols.get("nationalId")).toMatchObject({ filterable: true, filterOperators: ["eq"] });
    // A column outside the whitelist can do nothing.
    expect(cols.get("computed")).toMatchObject({ filterable: false, sortable: false });
    expect(disabled).toEqual(["price", "computed"]);
  });

  it("a column left with no rule the bar can offer is not filterable", () => {
    const onlyIn: DataTableEndpointMeta = {
      ...meta,
      fields: { ...meta.fields, name: { ...meta.fields.name!, filterOperators: ["in"] } },
    };
    const { columns: narrowed, disabled } = applyEndpointMeta([columns[1]!], onlyIn);
    expect(narrowed[0]).toMatchObject({ filterable: false, filterOperators: ["in"] });
    expect(disabled).toEqual(["name"]);
  });

  it("the column's own filterOperators intersect with the meta and never widen", () => {
    const { columns: narrowed } = applyEndpointMeta([{ ...columns[1]!, filterOperators: ["contains", "startsWith"] }], meta);
    expect(narrowed[0]!.filterOperators).toEqual(["contains"]);
  });

  it("a capability that is closed on the column is not opened even if the meta allows it", () => {
    const { columns: narrowed } = applyEndpointMeta([{ key: "name", title: "Name", type: "text" }], meta);
    expect(narrowed[0]).toMatchObject({ sortable: false });
    expect(narrowed[0]!.filterable).toBeUndefined();
  });
});

function sourceWithMeta(getMeta: DataSource<Row>["getMeta"]) {
  const fetch = vi.fn(async (query: DataTableQuery) => {
    const keys = query.filters?.filters[0] && "value" in query.filters.filters[0] ? query.filters.filters[0].value : [];
    const data = Array.isArray(keys) ? keys.map((id) => ({ id: Number(id), name: "x", price: 1, nationalId: "1" })) : [];
    return { data, pagination: { page: 1, pageSize: query.pagination.pageSize, total: data.length } };
  });
  return { fetch, getMeta } satisfies DataSource<Row>;
}

describe("useDataTable — endpoint meta", () => {
  it("narrows the search ceiling and the columns once the meta arrives", async () => {
    const dataSource = sourceWithMeta(() => Promise.resolve(meta));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));

    await waitFor(() => expect(result.current.limits.maxSearchLength).toBe(5));
    expect(result.current.limits).toMatchObject({
      maxFilterCount: meta.limits.maxFilterCount,
      maxFilterDepth: meta.limits.maxFilterDepth,
      maxInValues: meta.limits.maxInValues,
    });
    const nationalId = result.current.columns.find((c) => c.key === "nationalId");
    expect(nationalId?.filterOperators).toEqual(["eq"]);

    act(() => result.current.setSearch("Springfield"));
    await waitFor(() => expect(result.current.search).toBe("Sprin"));
  });

  it("a smaller manually supplied limit is kept despite the meta", async () => {
    const dataSource = sourceWithMeta(() => Promise.resolve(meta));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id", maxSearchLength: 3 }));
    await waitFor(() => expect(result.current.columns).not.toBe(columns));
    expect(result.current.limits.maxSearchLength).toBe(3);
  });

  it("the meta of a server speaking an unsupported protocol is ignored and warned about in dev mode", async () => {
    const warn = vi.mocked(console.warn);
    const dataSource = sourceWithMeta(() => Promise.resolve({ ...meta, protocol: { version: 2, supported: [2] } }));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));

    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("supports DataTableX protocol 2, the client speaks 1")));
    expect(result.current.limits.maxSearchLength).toBe(200);
    expect(result.current.columns).toBe(columns);
  });

  it("keeps working with the manually supplied values when the meta cannot be read", async () => {
    const warn = vi.mocked(console.warn);
    const dataSource = sourceWithMeta(() => Promise.reject(new Error("403")));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));

    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("The endpoint meta could not be read"), expect.any(Error)));
    expect(result.current.error).toBeNull();
    expect(result.current.limits).toEqual({ maxSearchLength: 200, maxFilterCount: null, maxFilterDepth: null, maxInValues: null });
    expect(result.current.columns).toBe(columns);
  });

  it("splits the selected export group according to maxInValues", async () => {
    const dataSource = sourceWithMeta(() => Promise.resolve(meta));
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.limits.maxSearchLength).toBe(5));

    act(() => result.current.setSelectedRowKeys([1, 2, 3, 4, 5]));
    dataSource.fetch.mockClear();
    await act(() => result.current.exportData("csv", "selected"));

    const chunks = dataSource.fetch.mock.calls.map(([q]) => (q.filters!.filters[0] as { value: number[] }).value);
    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("warns in dev when rowKey differs from the backend primaryKey", async () => {
    const warn = vi.mocked(console.warn);
    const dataSource = sourceWithMeta(() => Promise.resolve(meta));
    renderHook(() => useDataTable({ dataSource, columns, rowKey: "name" }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('rowKey "name"')));
  });
});
