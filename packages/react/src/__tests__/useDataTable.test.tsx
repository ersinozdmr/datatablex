import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, render, screen, act, waitFor } from "@testing-library/react";
import type { DataSource, DataTableQuery, DataTableResult } from "@datatablex/core";
import { useDataTable } from "../state/useDataTable.js";
import { createLocalDataSource } from "../query/createLocalDataSource.js";
import type { ReactDataTableColumn } from "../types.js";

interface Row {
  id: number;
  name: string;
  age: number;
}

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}`, age: 20 + (i % 30) }));
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "name", title: "Name", type: "text", searchable: true, sortable: true },
  { key: "age", title: "Age", type: "number", sortable: true },
];

describe("useDataTable", () => {
  it("fetches on mount and exposes the first page", async () => {
    const dataSource = createLocalDataSource(makeRows(45), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toHaveLength(20); // default page size
    expect(result.current.pagination).toMatchObject({ current: 1, pageSize: 20, total: 45 });
  });

  it("resets the page to 1 when sorting, filters or search change", async () => {
    const dataSource = createLocalDataSource(makeRows(45), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(result.current.pagination.current).toBe(2));

    act(() => result.current.setSorting([{ field: "age", direction: "asc" }]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pagination.current).toBe(1);

    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(result.current.pagination.current).toBe(2));

    act(() => result.current.setFilters({ operator: "AND", filters: [{ field: "age", operator: "gte", value: 20 }] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pagination.current).toBe(1);

    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(result.current.pagination.current).toBe(2));

    act(() => result.current.setSearch("Row"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pagination.current).toBe(1);
  });

  it("resets the page to 1 only when pageSize changes, not on a plain page turn", async () => {
    const dataSource = createLocalDataSource(makeRows(45), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(result.current.pagination.current).toBe(2));

    act(() => result.current.pagination.onChange(3, 10));
    await waitFor(() => expect(result.current.pagination.pageSize).toBe(10));
    expect(result.current.pagination.current).toBe(1); // pageSize changed → reset
  });

  it("preserves selectedRowKeys across pagination/filter/search/sort changes, clears only on reset()", async () => {
    const dataSource = createLocalDataSource(makeRows(45), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setSelectedRowKeys([1, 2, 3]));
    expect(result.current.selectedRowKeys).toEqual([1, 2, 3]);

    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(result.current.pagination.current).toBe(2));
    expect(result.current.selectedRowKeys).toEqual([1, 2, 3]);

    act(() => result.current.setSorting([{ field: "age", direction: "asc" }]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.selectedRowKeys).toEqual([1, 2, 3]);

    act(() => result.current.reset());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.selectedRowKeys).toEqual([]);
    expect(result.current.pagination.current).toBe(1);
  });

  it("corrects an out-of-range page once and refetches", async () => {
    const dataSource = createLocalDataSource(makeRows(45), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.pagination.onChange(999, 20));
    await waitFor(() => expect(result.current.pagination.current).toBe(3)); // ceil(45/20) = 3
    expect(result.current.data.length).toBeGreaterThan(0);
  });

  it("surfaces a rejected fetch as `error` and clears loading", async () => {
    const dataSource: DataSource<Row> = {
      fetch: () => Promise.reject(new Error("boom")),
    };
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("boom");
  });

  it("reload() resolves once the refetch completes and keeps the current page", async () => {
    const dataSource = createLocalDataSource(makeRows(45), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(result.current.pagination.current).toBe(2));

    // Not wrapped in act(): the returned promise only resolves once the
    // refetch's passive effect commits, so awaiting it inside act() would
    // deadlock (act() defers the very effect the promise is waiting on).
    await result.current.reload();
    expect(result.current.pagination.current).toBe(2);
  });

  it("ignores a stale response when a newer request supersedes it", async () => {
    let resolveFirst: ((result: DataTableResult<Row>) => void) | undefined;
    const fetchMock = vi
      .fn<(query: DataTableQuery) => Promise<DataTableResult<Row>>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ data: makeRows(1), pagination: { page: 1, pageSize: 20, total: 1 } }),
      );
    const dataSource: DataSource<Row> = { fetch: fetchMock };

    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));

    // trigger a second, superseding request before the first resolves
    act(() => result.current.setSearch("second"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // now let the stale first request resolve — it must be ignored
    act(() => resolveFirst?.({ data: makeRows(45), pagination: { page: 1, pageSize: 20, total: 45 } }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(1); // from the second (latest) request, not the stale 45
  });

  /**
   * Regression guard: an unstable `dataSource` reference must not cause an
   * unbounded render/fetch loop.
   */
  it("a dataSource recreated on every render does NOT start a re-query loop", async () => {
    const fetchSpy = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backing = createLocalDataSource(makeRows(5), columns);

    function Probe() {
      // INTENTIONAL contract violation: a new object identity on every render.
      const dataSource: DataSource<Row> = {
        fetch: (query) => {
          fetchSpy();
          return backing.fetch(query);
        },
      };
      const table = useDataTable({ dataSource, columns, rowKey: "id" });
      return <div data-testid="count">{table.data.length}</div>;
    }

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("5"));
    await new Promise((r) => setTimeout(r, 150)); // a loop would blow up within this window

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("The `dataSource` reference changed"));
    warnSpy.mockRestore();
  });

  it("when the dataSource identity changes, the dev warning is printed ONLY once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backing = createLocalDataSource(makeRows(3), columns);

    function Probe() {
      const dataSource: DataSource<Row> = { fetch: (q) => backing.fetch(q) };
      const table = useDataTable({ dataSource, columns, rowKey: "id" });
      return <div data-testid="count">{table.data.length}</div>;
    }

    const { rerender } = render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("3"));
    rerender(<Probe />);
    rerender(<Probe />);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("the TableInstance reference stays the SAME across re-renders where the state does not change", async () => {
    const dataSource = createLocalDataSource(makeRows(5), columns);
    const { result, rerender } = renderHook(() =>
      useDataTable({ dataSource, columns, rowKey: "id" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first); // useEffect(…, [table]) must not enter an infinite loop

    act(() => result.current.setSearch("x"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).not.toBe(first); // a new identity when the state changes
  });

  it("on unmount a pending reload() promise does not hang; it is rejected", async () => {
    const fetchMock = vi
      .fn<(query: DataTableQuery) => Promise<DataTableResult<Row>>>()
      .mockImplementationOnce(() =>
        Promise.resolve({ data: makeRows(2), pagination: { page: 1, pageSize: 20, total: 2 } }),
      )
      .mockImplementation(() => new Promise(() => {})); // the request of reload never resolves
    const dataSource: DataSource<Row> = { fetch: fetchMock };

    const { result, unmount } = renderHook(() =>
      useDataTable({ dataSource, columns, rowKey: "id" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.reload();
    });
    unmount();

    await expect(pending).rejects.toThrow(/unmount/);
  });

  /**
   * Even when the identity of `dataSource` changes intentionally (without
   * calling `reload()`), a fetch must be triggered: in the `<DataTable>`
   * shorthand form the caller has no access to `reload()` either.
   */
  it("when dataSourceKey changes, the NEW dataSource is queried automatically without reload()", async () => {
    const sourceA = createLocalDataSource(makeRows(3), columns);
    const sourceB = createLocalDataSource(makeRows(2), columns);
    const { result, rerender } = renderHook(
      ({ dataSource, dataSourceKey }: { dataSource: DataSource<Row>; dataSourceKey: string }) =>
        useDataTable({ dataSource, dataSourceKey, columns, rowKey: "id" }),
      { initialProps: { dataSource: sourceA, dataSourceKey: "a" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(3);

    rerender({ dataSource: sourceB, dataSourceKey: "b" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(2);
  });

  /**
   * Printing the warning when `dataSourceKey` is used correctly would be
   * factually wrong (a query WAS made) and would push the developer toward
   * a wrong fix after they did the right thing.
   */
  it("the dev warning is NOT printed for an intentional change made with dataSourceKey", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sourceA = createLocalDataSource(makeRows(3), columns);
    const sourceB = createLocalDataSource(makeRows(2), columns);
    const { result, rerender } = renderHook(
      ({ dataSource, dataSourceKey }: { dataSource: DataSource<Row>; dataSourceKey: string }) =>
        useDataTable({ dataSource, dataSourceKey, columns, rowKey: "id" }),
      { initialProps: { dataSource: sourceA, dataSourceKey: "a" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ dataSource: sourceB, dataSourceKey: "b" });
    await waitFor(() => expect(result.current.data).toHaveLength(2));

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("The `dataSource` reference changed"));
    warnSpy.mockRestore();
  });

  it("the warning is still printed when dataSource changes while dataSourceKey stays the SAME", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sourceA = createLocalDataSource(makeRows(3), columns);
    const sourceB = createLocalDataSource(makeRows(2), columns);
    const { result, rerender } = renderHook(
      ({ dataSource }: { dataSource: DataSource<Row> }) =>
        useDataTable({ dataSource, dataSourceKey: "sabit", columns, rowKey: "id" }),
      { initialProps: { dataSource: sourceA } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ dataSource: sourceB });
    await waitFor(() => expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("The `dataSource` reference changed")));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dataSourceKey"));
    warnSpy.mockRestore();
  });

  /**
   * When a result drops to `total: 0`, the page correction must not be
   * skipped, otherwise an inconsistent state such as "page 2 / 0 records"
   * would remain.
   */
  it("when total drops to 0, an out-of-range page is pulled back to 1", async () => {
    const rows = makeRows(45);
    const dataSource = createLocalDataSource(rows, columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.pagination.onChange(2, 20));
    await waitFor(() => expect(result.current.pagination.current).toBe(2));

    rows.length = 0; // all data was deleted
    // Not wrapped in act(): see the note in the "reload() resolves..." test above.
    await result.current.reload();

    await waitFor(() => expect(result.current.pagination.total).toBe(0));
    expect(result.current.pagination.current).toBe(1);
  });
});

describe("useDataTable — column state and density", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("without tableId persistence never kicks in; columnState stays in memory only", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.columnState).toEqual([
      { key: "id", hidden: false, width: undefined, order: 0, wrap: true },
      { key: "name", hidden: false, width: undefined, order: 1, wrap: true },
      { key: "age", hidden: false, width: undefined, order: 2, wrap: true },
    ]);
    expect(window.localStorage.length).toBe(0);
  });

  it("with tableId, setColumnState writes to localStorage; a new mount reads the same record", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result, unmount } = renderHook(() =>
      useDataTable({ dataSource, columns, rowKey: "id", tableId: "acc-logs" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() =>
      result.current.setColumnState([
        { key: "id", order: 1, hidden: false },
        { key: "name", order: 0, hidden: true },
        { key: "age", order: 2, hidden: false },
      ]),
    );
    expect(result.current.columnState.find((c) => c.key === "name")).toMatchObject({ hidden: true, order: 0 });
    unmount();

    const { result: second } = renderHook(() =>
      useDataTable({ dataSource, columns, rowKey: "id", tableId: "acc-logs" }),
    );
    expect(second.current.columnState.find((c) => c.key === "name")).toMatchObject({ hidden: true, order: 0 });
  });

  it("when schemaVersion increases, the old record is treated as irreconcilable and the defaults are restored", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result: first, unmount } = renderHook(() =>
      useDataTable({ dataSource, columns, rowKey: "id", tableId: "acc-logs-v", schemaVersion: 1 }),
    );
    await waitFor(() => expect(first.current.loading).toBe(false));
    act(() => first.current.setColumnState(first.current.columnState.map((c) => ({ ...c, hidden: true }))));
    unmount();

    const { result: second } = renderHook(() =>
      useDataTable({ dataSource, columns, rowKey: "id", tableId: "acc-logs-v", schemaVersion: 2 }),
    );
    expect(second.current.columnState.every((c) => !c.hidden)).toBe(true); // back to the default
  });

  /**
   * The "at least one visible column" invariant lives in `normalizeColumnState`;
   * it must also be applied on the `resetColumns` path, otherwise mount shows
   * the first column while "Reset view" would empty the table completely.
   */
  it("even if all columns are defaultHidden, resetColumns() does not empty the table", async () => {
    const allHidden: ReactDataTableColumn<Row>[] = columns.map((c) => ({ ...c, defaultHidden: true }));
    const dataSource = createLocalDataSource(makeRows(3), allHidden);
    const { result } = renderHook(() => useDataTable({ dataSource, columns: allHidden, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.columnState.filter((c) => !c.hidden)).toHaveLength(1);

    act(() => result.current.resetColumns());

    expect(result.current.columnState.find((c) => c.order === 0)?.hidden).toBe(false);
    expect(result.current.columnState.filter((c) => !c.hidden)).toHaveLength(1);
  });

  it("resetColumns() deletes the saved state and returns to the default in the columns prop", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result } = renderHook(() =>
      useDataTable({ dataSource, columns, rowKey: "id", tableId: "acc-logs-reset" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setColumnState(result.current.columnState.map((c) => ({ ...c, hidden: true }))));
    // Normalization enforces the "at least one visible column" invariant: even
    // if all are requested hidden, the FIRST column in order (order 0) stays visible.
    expect(result.current.columnState.find((c) => c.order === 0)?.hidden).toBe(false);
    expect(result.current.columnState.filter((c) => c.hidden)).toHaveLength(result.current.columnState.length - 1);

    act(() => result.current.resetColumns());
    expect(result.current.columnState.every((c) => !c.hidden)).toBe(true);
    expect(window.localStorage.getItem("datatablex:columns:acc-logs-reset")).toBeNull();
  });

  it("reset() resets the query state but does NOT touch columnState/density", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setColumnState(result.current.columnState.map((c) => ({ ...c, hidden: true }))));
    act(() => result.current.setDensity("small"));

    act(() => result.current.reset());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // order 0 is forced to stay visible (see the resetColumns() test above).
    expect(result.current.columnState.find((c) => c.order === 0)?.hidden).toBe(false);
    expect(result.current.columnState.filter((c) => c.hidden)).toHaveLength(result.current.columnState.length - 1);
    expect(result.current.density).toBe("small");
  });

  it("density defaults to 'middle' and can be changed with setDensity", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id" }));
    expect(result.current.density).toBe("middle");

    act(() => result.current.setDensity("small"));
    expect(result.current.density).toBe("small");
  });

  it("without headerDensity it copies the INITIAL value of density but is INDEPENDENT afterwards", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result } = renderHook(() => useDataTable({ dataSource, columns, rowKey: "id", density: "small" }));
    expect(result.current.headerDensity).toBe("small");

    act(() => result.current.setDensity("large"));
    expect(result.current.density).toBe("large");
    expect(result.current.headerDensity).toBe("small"); // the density change did NOT affect headerDensity

    act(() => result.current.setHeaderDensity("mini"));
    expect(result.current.headerDensity).toBe("mini");
    expect(result.current.density).toBe("large"); // independent in the reverse direction too
  });

  it("when headerDensity is given separately, it starts INDEPENDENT of density", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result } = renderHook(() =>
      useDataTable({ dataSource, columns, rowKey: "id", density: "middle", headerDensity: "compact" }),
    );
    expect(result.current.density).toBe("middle");
    expect(result.current.headerDensity).toBe("compact");
  });

  /**
   * `columns` is passed with a NEW reference on every rerender (like an array
   * literal defined in a component body); otherwise `useEffect(..., [columns])`
   * would run only once anyway, and what makes the test pass would be the
   * effect's dependency array rather than the `columnKeyWarnedRef` guard.
   */
  it("a duplicate key in columns warns once in a dev build (even if the columns identity changes on every render)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const makeDupColumns = (): ReactDataTableColumn<Row>[] => [
      { key: "id", title: "ID" },
      { key: "id", title: "ID again" },
    ];
    const dataSource = createLocalDataSource(makeRows(3), makeDupColumns());
    const { result, rerender } = renderHook(({ columns }) => useDataTable({ dataSource, columns, rowKey: "id" }), {
      initialProps: { columns: makeDupColumns() },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ columns: makeDupColumns() });
    rerender({ columns: makeDupColumns() });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Duplicate key found in columns"));
    warnSpy.mockRestore();
  });

  /**
   * `columnState` is a value DERIVED from the `columns` prop, so it must be
   * recomputed when `columns` changes, not only in the `useState` initializer.
   */
  it("a column added at runtime enters columnState and is appended at the END", async () => {
    const colsA: ReactDataTableColumn<Row>[] = [
      { key: "id", title: "ID" },
      { key: "name", title: "Name" },
    ];
    const colsB: ReactDataTableColumn<Row>[] = [...colsA, { key: "age", title: "Age" }];
    const dataSource = createLocalDataSource(makeRows(3), colsB);
    const { result, rerender } = renderHook(({ columns }) => useDataTable({ dataSource, columns, rowKey: "id" }), {
      initialProps: { columns: colsA as ReactDataTableColumn<Row>[] },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.columnState.map((c) => c.key)).toEqual(["id", "name"]);

    rerender({ columns: colsB });
    await waitFor(() => expect(result.current.columnState.map((c) => c.key)).toEqual(["id", "name", "age"]));
    expect(result.current.columnState.map((c) => c.order)).toEqual([0, 1, 2]);
  });

  it("a column removed at runtime leaves no ghost entry in columnState", async () => {
    const colsA: ReactDataTableColumn<Row>[] = [
      { key: "id", title: "ID" },
      { key: "name", title: "Name" },
      { key: "age", title: "Age" },
    ];
    const colsB: ReactDataTableColumn<Row>[] = colsA.slice(0, 2);
    const dataSource = createLocalDataSource(makeRows(3), colsA);
    const { result, rerender } = renderHook(({ columns }) => useDataTable({ dataSource, columns, rowKey: "id" }), {
      initialProps: { columns: colsA },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ columns: colsB });
    await waitFor(() => expect(result.current.columnState.map((c) => c.key)).toEqual(["id", "name"]));
  });

  /**
   * If `tableId` changes at runtime, the hook reads the record of the NEW
   * key; the read and write keys stay in sync.
   */
  it("when tableId changes at runtime, the record of the NEW key is read", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result, rerender } = renderHook(({ tableId }) => useDataTable({ dataSource, columns, rowKey: "id", tableId }), {
      initialProps: { tableId: "table-a" },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setColumnState(result.current.columnState.map((c) => (c.key === "name" ? { ...c, hidden: true } : c))));
    expect(result.current.columnState.find((c) => c.key === "name")).toMatchObject({ hidden: true });

    // There is no record for "table-b" yet, so it returns to the default (the old "table-a" state does not leak).
    rerender({ tableId: "table-b" });
    await waitFor(() => expect(result.current.columnState.every((c) => !c.hidden)).toBe(true));

    // When returning to "table-a", its own record comes back.
    rerender({ tableId: "table-a" });
    await waitFor(() =>
      expect(result.current.columnState.find((c) => c.key === "name")).toMatchObject({ hidden: true }),
    );
  });

  /**
   * If `tableId` drops from a defined value to `undefined`, persistence is
   * considered OFF by contract; the in-memory state of the old identity must
   * not be persisted in the new (id-less) table.
   */
  it("when tableId drops from a defined value to undefined, it returns to the columns default", async () => {
    const dataSource = createLocalDataSource(makeRows(3), columns);
    const { result, rerender } = renderHook(
      ({ tableId }: { tableId?: string }) => useDataTable({ dataSource, columns, rowKey: "id", tableId }),
      { initialProps: { tableId: "table-a" as string | undefined } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() =>
      result.current.setColumnState(
        result.current.columnState.map((c) => (c.key === "name" ? { ...c, hidden: true } : c)),
      ),
    );
    expect(result.current.columnState.find((c) => c.key === "name")).toMatchObject({ hidden: true });

    rerender({ tableId: undefined });
    await waitFor(() => expect(result.current.columnState.every((c) => !c.hidden)).toBe(true));
  });
});
