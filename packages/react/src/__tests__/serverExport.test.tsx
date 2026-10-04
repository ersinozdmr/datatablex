import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalDataSource } from "../query/createLocalDataSource.js";
import { createRestDataSource, DataTableRequestError } from "../query/createRestDataSource.js";
import { useDataTable } from "../state/useDataTable.js";
import { downloadExport, serverExportColumnsFor, startDownload } from "../export/exportFile.js";
import { ExportBusyError, ExportRowLimitError } from "../export/errors.js";
import { excelExporter } from "../excel.js";
import type { DataSource, DataTableEndpointMeta, DataTableExportDownload, DataTableExportRequest, DataTableQuery, FilterGroup } from "@datatablex/core";
import type { ExportOutcome, ReactDataTableColumn } from "../types.js";

vi.mock("../export/exportFile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../export/exportFile.js")>()),
  startDownload: vi.fn(),
  downloadExport: vi.fn(async () => {}),
}));

interface Row {
  id: number;
  name: string;
  secret: string;
  masked: string;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "No" },
  { key: "name", title: "Name", filterable: true },
  { key: "masked", title: "Mask", accessor: "masked", field: "secret" },
  { key: "computed", title: "Computed", field: null, accessor: (r) => r.name.length },
];

const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `r${i + 1}`, secret: "s", masked: "*" }));

type ExportMeta = NonNullable<DataTableEndpointMeta["export"]>;

const TICKET_META: ExportMeta = {
  formats: { csv: 100_000, excel: 50_000, pdf: 20 },
  fields: ["id", "name", "masked"],
};

const meta = (exportBlock?: ExportMeta): DataTableEndpointMeta => ({
  version: 1,
  protocol: { version: 1, supported: [1] },
  primaryKey: "id",
  limits: { maxPageSize: 500, maxFilterDepth: 3, maxFilterCount: 50, maxInValues: 500, maxSearchLength: 200, maxSortCount: 3, maxOffset: null },
  fields: {
    id: { type: "number", filterOperators: ["eq", "in"], sortable: false, searchable: false },
    name: { type: "text", filterOperators: ["contains"], sortable: true, searchable: false },
  },
  ...(exportBlock ? { export: exportBlock } : null),
});

function serverSource(options: { exportBlock?: ExportMeta | null; withMeta?: boolean } = {}) {
  const local = createLocalDataSource(rows, columns);
  const queries: DataTableQuery[] = [];
  const requests: DataTableExportRequest[] = [];
  const requestExport = vi.fn(async (request: DataTableExportRequest, opts?: { signal?: AbortSignal }): Promise<DataTableExportDownload> => {
    requests.push(request);
    if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return { ticket: "t1", total: 3, filename: request.filename ?? "export", expiresAt: "2026-09-27T00:00:00.000Z", downloadUrl: "/q/export/download?ticket=t1" };
  });
  const exportBlock = options.exportBlock === undefined ? TICKET_META : (options.exportBlock ?? undefined);
  const source: DataSource<Row> = {
    fetch: async (query, fetchOptions) => {
      queries.push(query);
      return local.fetch(query, fetchOptions);
    },
    requestExport,
    ...(options.withMeta === false ? null : { getMeta: async () => meta(exportBlock) }),
  };
  return { source, queries, requests, requestExport };
}

const mockedStart = vi.mocked(startDownload);
const mockedClientDownload = vi.mocked(downloadExport);

beforeEach(() => {
  mockedStart.mockClear();
  mockedClientDownload.mockClear();
});
afterEach(() => vi.restoreAllMocks());

async function readyTable(source: DataSource<Row>, extra: Record<string, unknown> = {}) {
  const hook = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", tableId: "t", ...extra }));
  await waitFor(() => expect(hook.result.current.limits.maxFilterCount).toBe(50));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe("serverExportColumnsFor", () => {
  const state = columns.map((c, order) => ({ key: c.key, order, hidden: false }));

  it("uses the field of the displayed value; skips computed columns and columns outside the whitelist", () => {
    expect(serverExportColumnsFor(columns, state, null)).toEqual({
      columns: [
        { field: "id", title: "No" },
        { field: "name", title: "Name" },
        { field: "masked", title: "Mask" },
      ],
      skipped: ["computed"],
    });
    expect(serverExportColumnsFor(columns, state, new Set(["id"])).skipped).toEqual(["name", "masked", "computed"]);
  });
});

describe("useDataTable — sunucu export'u (bilet + native indirme)", () => {
  it("allFiltered: a ticket is requested and the download starts; no paged requests", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { source, queries, requests } = serverSource();
    const locked: FilterGroup = { operator: "AND", filters: [{ field: "id", operator: "gte", value: 2 }] };
    const { result } = await readyTable(source, { lockedFilters: locked });
    act(() => result.current.setSearch("r"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    queries.length = 0;

    let outcome!: ExportOutcome;
    await act(async () => {
      outcome = await result.current.exportData("excel", "allFiltered", { filename: "x.xlsx", title: "Title" });
    });

    expect(outcome).toBe("started");
    expect(queries).toHaveLength(0);
    expect(requests[0]).toEqual({
      query: { sorting: [], filters: locked, search: "r" },
      format: "excel",
      scope: "allFiltered",
      columns: [
        { field: "id", title: "No" },
        { field: "name", title: "Name" },
        { field: "masked", title: "Mask" },
      ],
      filename: "x.xlsx",
      title: "Title",
    });
    expect(mockedStart).toHaveBeenCalledWith("/q/export/download?ticket=t1", "x.xlsx");
    expect(mockedClientDownload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("computed"));
    expect(result.current.isExporting).toBe(false);
    expect(result.current.exportProgress).toBeNull();
  });

  it("currentPage: the query carries the pagination; selected: keys, without filter and search", async () => {
    const { source, requests } = serverSource();
    const { result } = await readyTable(source);
    act(() => result.current.setFilters({ operator: "AND", filters: [{ field: "name", operator: "contains", value: "r" }] }));
    // Changing the page size returns to page 1; size first, then page.
    act(() => result.current.pagination.onChange(1, 10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.pagination.onChange(2, 10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setSelectedRowKeys([3, 1, 3]));

    await act(async () => result.current.exportData("pdf", "currentPage"));
    expect(requests[0]).toMatchObject({ scope: "currentPage", format: "pdf", query: { pagination: { page: 2, pageSize: 10 } } });
    expect(requests[0]!.filename).toMatch(/^t-\d{4}-\d{2}-\d{2}\.pdf$/);

    await act(async () => result.current.exportData("csv", "selected"));
    expect(requests[1]).toMatchObject({ scope: "selected", keys: [3, 1], query: { filters: null, search: undefined } });
    expect(requests[1]).not.toHaveProperty("query.pagination");
    expect(mockedStart).toHaveBeenCalledTimes(2);
  });

  it("when rowKey differs from the backend primaryKey, a `selected` export is rejected without a request (fail-closed)", async () => {
    const { source, requestExport, queries } = serverSource();
    const { result } = await readyTable(source, { rowKey: "name" });
    expect(result.current.exportSelectionBlocked).toBe(true);
    act(() => result.current.setSelectedRowKeys(["r1", "r2"]));
    queries.length = 0;

    const error = await result.current.exportData("csv", "selected").catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "DataTableExportError", code: "export_selection_key" });
    expect(requestExport).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
    expect(mockedClientDownload).not.toHaveBeenCalled();
    expect(result.current.isExporting).toBe(false);
    // Other scopes are not affected.
    await act(async () => result.current.exportData("csv", "allFiltered"));
    expect(requestExport).toHaveBeenCalledTimes(1);
  });

  it("`selected` is not blocked when rowKey equals primaryKey or there is no meta", async () => {
    const { source } = serverSource();
    const { result } = await readyTable(source);
    expect(result.current.exportSelectionBlocked).toBe(false);

    const noMeta = serverSource({ withMeta: false });
    const hook = renderHook(() => useDataTable({ dataSource: noMeta.source, columns, rowKey: "name" }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.exportSelectionBlocked).toBe(false);
  });

  it("the server limit of the format is checked against the known total without a request", async () => {
    const { source, requestExport } = serverSource();
    const { result } = await readyTable(source);
    // formats.pdf = 20; the table has 30 rows.
    const error = await result.current.exportData("pdf", "allFiltered").catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ExportRowLimitError", total: 30, maxRows: 20, source: "server" });
    expect(requestExport).not.toHaveBeenCalled();
  });

  it("the server's 413 becomes ExportRowLimitError (server), its 429 becomes ExportBusyError", async () => {
    const { source, requestExport } = serverSource();
    const { result } = await readyTable(source);
    requestExport.mockRejectedValueOnce(new DataTableRequestError("too large", 413, { error: "Export Too Large", total: 200_000, maxRows: 100_000 }));
    expect(await result.current.exportData("csv").catch((e: unknown) => e)).toMatchObject({ name: "ExportRowLimitError", total: 200_000, maxRows: 100_000, source: "server" });
    requestExport.mockRejectedValueOnce(new DataTableRequestError("busy", 429, { error: "Too Many Exports", maxConcurrent: 4 }));
    const busy = await result.current.exportData("csv").catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ExportBusyError);
    expect(busy).toMatchObject({ maxConcurrent: 4 });
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it("cancelExport cuts the ticket request; the download does not start, the outcome is 'cancelled'", async () => {
    const { source, requestExport } = serverSource();
    requestExport.mockImplementationOnce(
      (_request, opts) =>
        new Promise((_resolve, reject) => opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const { result } = await readyTable(source);
    let done!: Promise<ExportOutcome>;
    act(() => {
      done = result.current.exportData("csv");
    });
    await waitFor(() => expect(result.current.isExporting).toBe(true));
    act(() => result.current.cancelExport());
    await act(async () => expect(done).resolves.toBe("cancelled"));
    expect(mockedStart).not.toHaveBeenCalled();
    expect(result.current.isExporting).toBe(false);
  });

  it("exportFormats includes the server's formats once the meta arrives; no adapter is needed", async () => {
    const { source } = serverSource();
    const { result } = await readyTable(source);
    expect(result.current.exportFormats).toEqual(["csv", "excel", "pdf"]);
  });

  it("when the meta declares no export block, the client's paged path is used", async () => {
    const { source, requestExport, queries } = serverSource({ exportBlock: null });
    const { result } = await readyTable(source);
    expect(result.current.exportFormats).toEqual(["csv"]);
    queries.length = 0;
    await act(async () => result.current.exportData("csv", "allFiltered"));
    expect(requestExport).not.toHaveBeenCalled();
    expect(queries.length).toBeGreaterThan(0);
    expect(mockedClientDownload).toHaveBeenCalledTimes(1);
  });

  it("a source without meta does not use the server path: the formats cannot be known", async () => {
    const { source, requestExport } = serverSource({ withMeta: false });
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => result.current.exportData("csv", "allFiltered"));
    expect(requestExport).not.toHaveBeenCalled();
    expect(mockedClientDownload).toHaveBeenCalledTimes(1);
  });
});

describe("useDataTable — maxClientExportRows (istemci yolu)", () => {
  it("defaults are CSV 100 000, Excel 50 000, PDF 10 000; a number applies to all three formats, an object per format", async () => {
    const { source, queries } = serverSource({ exportBlock: null });
    const { result, rerender } = renderHook((props: { max?: number | { csv?: number; excel?: number; pdf?: number } }) =>
      useDataTable({ dataSource: source, columns, rowKey: "id", exporters: [excelExporter], maxClientExportRows: props.max }),
    { initialProps: {} },
    );
    await waitFor(() => expect(result.current.pagination.total).toBe(30));
    await act(async () => result.current.exportData("excel", "allFiltered"));
    expect(mockedClientDownload).toHaveBeenCalledTimes(1);

    rerender({ max: 10 });
    queries.length = 0;
    expect(await result.current.exportData("excel", "allFiltered").catch((e: unknown) => e)).toMatchObject({ total: 30, maxRows: 10, source: "client" });
    expect(queries).toHaveLength(0);

    rerender({ max: { pdf: 5 } });
    await act(async () => result.current.exportData("excel", "allFiltered"));
    expect(mockedClientDownload).toHaveBeenCalledTimes(2);
  });

  it("also stops when the number of selected rows exceeds the limit", async () => {
    const { source } = serverSource({ withMeta: false });
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", exporters: [excelExporter], maxClientExportRows: { excel: 1 } }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setSelectedRowKeys([1, 2]));
    await waitFor(() => expect(result.current.selectedRowKeys).toEqual([1, 2]));
    expect(await result.current.exportData("excel", "selected").catch((e: unknown) => e)).toBeInstanceOf(ExportRowLimitError);
    await act(async () => result.current.exportData("csv", "allFiltered"));
    expect(mockedClientDownload).toHaveBeenCalledTimes(1);
  });

  it("CSV is not unlimited either: when the limit is exceeded, ExportRowLimitError (format: csv) is thrown before starting; Infinity removes it explicitly", async () => {
    const { source, queries } = serverSource({ withMeta: false });
    const { result, rerender } = renderHook((props: { max: number }) =>
      useDataTable({ dataSource: source, columns, rowKey: "id", maxClientExportRows: props.max }),
    { initialProps: { max: 10 } },
    );
    await waitFor(() => expect(result.current.pagination.total).toBe(30));
    queries.length = 0;
    const error = await result.current.exportData("csv", "allFiltered").catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ExportRowLimitError", total: 30, maxRows: 10, source: "client", format: "csv", code: "export_too_large" });
    expect(String((error as Error).message)).toContain("CSV");
    expect(queries).toHaveLength(0);
    expect(mockedClientDownload).not.toHaveBeenCalled();

    rerender({ max: Number.POSITIVE_INFINITY });
    await act(async () => result.current.exportData("csv", "allFiltered"));
    expect(mockedClientDownload).toHaveBeenCalledTimes(1);
  });
});

describe("createRestDataSource — requestExport", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const request: DataTableExportRequest = { query: { sorting: [], filters: null }, format: "excel", columns: [{ field: "id", title: "No" }] };
  const ticket = { ticket: "a b+/", total: 7, filename: "x.xlsx", expiresAt: "2026-09-27T00:01:00.000Z" };

  it("with metaEndpoint, `${endpoint}/export` is assumed; false turns it off; with neither, there is none", () => {
    expect(createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta" }).requestExport).toBeTypeOf("function");
    expect(createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta", exportEndpoint: false }).requestExport).toBeUndefined();
    expect(createRestDataSource({ endpoint: "/q" }).requestExport).toBeUndefined();
    expect(createRestDataSource({ endpoint: "/q", exportEndpoint: "/x" }).requestExport).toBeTypeOf("function");
  });

  it("requests the ticket with the protocol and custom headers; derives the download URL from the export URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(ticket), { status: 200 }));
    const source = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta", headers: { authorization: "Bearer t" } });
    const result = await source.requestExport!(request);
    expect(result).toEqual({ ...ticket, downloadUrl: "/q/export/download?ticket=a%20b%2B%2F" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/q/export/ticket");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-datatablex-protocol": "1", authorization: "Bearer t" });
    expect(JSON.parse(init.body)).toEqual(request);
  });

  it("an error response is a DataTableRequestError; an unrecognized body is a clear error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Export Too Large", message: "too many", total: 9, maxRows: 5 }), { status: 413 }));
    const source = createRestDataSource({ endpoint: "/q", exportEndpoint: "https://api.example.com/q/export" });
    await expect(source.requestExport!(request)).rejects.toMatchObject({ status: 413, body: { maxRows: 5 } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "x" }), { status: 200 }));
    await expect(source.requestExport!(request)).rejects.toThrow(/recognized export ticket/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(ticket), { status: 200 }));
    expect((await source.requestExport!(request)).downloadUrl).toBe("https://api.example.com/q/export/download?ticket=a%20b%2B%2F");
  });
});
