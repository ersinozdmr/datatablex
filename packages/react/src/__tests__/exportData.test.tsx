import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource, DataTableQuery } from "@datatablex/core";
import { createLocalDataSource } from "../query/createLocalDataSource.js";
import type { ExportOutcome, ReactDataTableColumn } from "../types.js";
import { useDataTable } from "../state/useDataTable.js";
import { downloadExport } from "../export/exportFile.js";
import { excelExporter } from "../excel.js";
import { pdfExporter } from "../pdf.js";

const exporters = [excelExporter, pdfExporter];

vi.mock("../export/exportFile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../export/exportFile.js")>()),
  downloadExport: vi.fn(async () => {}),
}));

interface Row {
  id: number;
  name: string;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID" },
  { key: "name", title: "Name", exportValue: (row) => row.name.toUpperCase() },
];

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `row-${index + 1}` }));
}

function recordingSource(data: Row[]) {
  const local = createLocalDataSource(data, columns);
  const queries: DataTableQuery[] = [];
  const source: DataSource<Row> = {
    fetch: async (query) => {
      queries.push(query);
      return local.fetch(query);
    },
  };
  return { source, queries };
}

const mockedDownload = vi.mocked(downloadExport);

describe("useDataTable exportData", () => {
  beforeEach(() => mockedDownload.mockClear());

  it("for allFiltered, fetches the first page with COUNT and the following pages with skipCount", async () => {
    const { source, queries } = recordingSource(rows(45));
    const { result } = renderHook(() =>
      useDataTable({ dataSource: source, columns, rowKey: "id", exporters, exportChunkSize: 15 }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    queries.length = 0;

    await act(async () => result.current.exportData("csv"));

    expect(queries).toHaveLength(3);
    expect(queries.map((query) => query.pagination.page)).toEqual([1, 2, 3]);
    expect(queries.map((query) => query.skipCount)).toEqual([undefined, true, true]);
    expect(mockedDownload).toHaveBeenCalledWith(
      "csv",
      expect.arrayContaining([expect.objectContaining({ title: "Name" })]),
      expect.arrayContaining([expect.objectContaining({ id: 45 })]),
      expect.stringMatching(/^export-\d{4}-\d{2}-\d{2}\.csv$/),
      null,
    );
    expect(result.current.isExporting).toBe(false);
    expect(result.current.exportProgress).toBeNull();
  });

  it("allFiltered downloads all pages without a client row limit", async () => {
    const { source, queries } = recordingSource(rows(51));
    const { result } = renderHook(() =>
      useDataTable({ dataSource: source, columns, rowKey: "id", exporters, exportChunkSize: 15 }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    queries.length = 0;

    await act(async () => result.current.exportData("csv"));

    expect(queries).toHaveLength(4);
    expect(queries.map((query) => query.pagination.page)).toEqual([1, 2, 3, 4]);
    expect(queries.map((query) => query.skipCount)).toEqual([undefined, true, true, true]);
    expect(mockedDownload).toHaveBeenCalledWith(
      "csv",
      expect.any(Array),
      expect.arrayContaining([expect.objectContaining({ id: 51 })]),
      expect.any(String),
      null,
    );
    expect(result.current.isExporting).toBe(false);
    expect(result.current.exportProgress).toBeNull();
  });

  it("Excel produces the default file name with a valid .xlsx extension", async () => {
    const { source } = recordingSource(rows(1));
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", exporters, tableId: "access-logs" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.exportData("excel", "currentPage"));

    expect(mockedDownload).toHaveBeenCalledWith(
      "excel",
      expect.any(Array),
      expect.arrayContaining([expect.objectContaining({ id: 1 })]),
      expect.stringMatching(/^access-logs-\d{4}-\d{2}-\d{2}\.xlsx$/),
      { exporter: excelExporter, title: "Export" },
    );
  });

  it("PDF produces the default file name with a valid .pdf extension", async () => {
    const { source } = recordingSource(rows(1));
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", exporters, tableId: "access-logs" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.exportData("pdf", "currentPage"));

    expect(mockedDownload).toHaveBeenCalledWith(
      "pdf",
      expect.any(Array),
      expect.arrayContaining([expect.objectContaining({ id: 1 })]),
      expect.stringMatching(/^access-logs-\d{4}-\d{2}-\d{2}\.pdf$/),
      { exporter: pdfExporter, title: "Export" },
    );
  });

  it("fetches the selected scope in groups with skipCount, without combining it with the active filter", async () => {
    const { source, queries } = recordingSource(rows(5));
    const { result } = renderHook(() =>
      useDataTable({ dataSource: source, columns, rowKey: "id", exporters, exportChunkSize: 2 }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setFilters({ operator: "AND", filters: [{ field: "name", operator: "contains", value: "row-1" }] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setSelectedRowKeys([1, 3, 5]));
    queries.length = 0;

    await act(async () => result.current.exportData("csv", "selected", { filename: "secililer.csv" }));

    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.skipCount)).toBe(true);
    expect(queries.map((query) => query.filters)).toEqual([
      { operator: "AND", filters: [{ field: "id", operator: "in", value: [1, 3] }] },
      { operator: "AND", filters: [{ field: "id", operator: "in", value: [5] }] },
    ]);
    expect(mockedDownload).toHaveBeenLastCalledWith("csv", expect.any(Array), expect.arrayContaining([{ id: 5, name: "row-5" }]), "secililer.csv", null);
  });

  it("rejects an empty selected export without a network request or a state change", async () => {
    const { source, queries } = recordingSource(rows(2));
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", exporters }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    queries.length = 0;

    await expect(result.current.exportData("csv", "selected")).rejects.toMatchObject({ name: "DataTableExportError", code: "no_rows_selected" });
    expect(queries).toHaveLength(0);
    expect(result.current.isExporting).toBe(false);
  });
});

describe("useDataTable exportData — cancellation and consistency", () => {
  beforeEach(() => mockedDownload.mockClear());

  /** A source that holds requests from page 2 on until `release` is called; the signal of every request is recorded. */
  function gatedSource(data: Row[]) {
    const local = createLocalDataSource(data, columns);
    const signals: Array<AbortSignal | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source: DataSource<Row> = {
      fetch: async (query, options) => {
        signals.push(options?.signal);
        if (query.pagination.page > 1) await gate;
        return local.fetch(query);
      },
    };
    return { source, signals, release: () => release() };
  }

  it("cancelExport ends a running export silently; the request signal is aborted and no file is produced", async () => {
    const { source, signals, release } = gatedSource(rows(45));
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", exporters, exportChunkSize: 15 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    signals.length = 0;

    let exporting!: Promise<ExportOutcome>;
    act(() => {
      exporting = result.current.exportData("csv");
    });
    await waitFor(() => expect(signals).toHaveLength(2));
    act(() => result.current.cancelExport());
    release();

    await act(async () => expect(exporting).resolves.toBe("cancelled"));
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    expect(mockedDownload).not.toHaveBeenCalled();
    expect(result.current.isExporting).toBe(false);
    expect(result.current.exportProgress).toBeNull();
  });

  it("unmount cancels a running export", async () => {
    const { source, signals, release } = gatedSource(rows(45));
    const { result, unmount } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", exporters, exportChunkSize: 15 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    signals.length = 0;

    let exporting!: Promise<ExportOutcome>;
    act(() => {
      exporting = result.current.exportData("csv");
    });
    await waitFor(() => expect(signals).toHaveLength(2));
    unmount();
    release();

    await expect(exporting).resolves.toBe("cancelled");
    expect(signals[1]?.aborted).toBe(true);
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it("a currentPage export is rejected while the table is loading; no network request is made", async () => {
    let resolveFetch!: () => void;
    const local = createLocalDataSource(rows(3), columns);
    const source: DataSource<Row> = {
      fetch: async (query) => {
        await new Promise<void>((resolve) => (resolveFetch = resolve));
        return local.fetch(query);
      },
    };
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", exporters }));
    expect(result.current.loading).toBe(true);

    await expect(result.current.exportData("csv", "currentPage")).rejects.toThrow(/while the table is loading/);
    expect(result.current.isExporting).toBe(false);
    expect(mockedDownload).not.toHaveBeenCalled();
    await act(async () => resolveFetch());
  });

  it("the PDF title comes from options.title", async () => {
    const { source } = recordingSource(rows(1));
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", exporters }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.exportData("pdf", "currentPage", { title: "Access logs" }));
    expect(mockedDownload).toHaveBeenCalledWith("pdf", expect.any(Array), expect.any(Array), expect.any(String), { exporter: pdfExporter, title: "Access logs" });
  });
});

describe("useDataTable exportData — adapter registry", () => {
  beforeEach(() => mockedDownload.mockClear());

  it("an unregistered format is rejected with a clear error, without a network request or a state change", async () => {
    const { source, queries } = recordingSource(rows(3));
    const { result } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    queries.length = 0;

    await expect(result.current.exportData("excel", "currentPage")).rejects.toThrow(/@datatablex\/react\/excel/);
    expect(queries).toHaveLength(0);
    expect(result.current.isExporting).toBe(false);
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it("exportFormats lists CSV plus the registered formats; an inline array does not change the TableInstance identity", async () => {
    const { source } = recordingSource(rows(3));
    const { result, rerender } = renderHook(() => useDataTable({ dataSource: source, columns, rowKey: "id", exporters: [pdfExporter] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.exportFormats).toEqual(["csv", "pdf"]);
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });
});

