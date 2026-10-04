import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import type { DataSource } from "@datatablex/core";
import { DataTable } from "../DataTable.js";
import { useDataTable } from "@datatablex/react";
import { createLocalDataSource } from "@datatablex/react";
import { DataTableRequestError } from "@datatablex/react";
import { sortLabelsFor } from "../ColumnHeaderMenu.js";
import type { ReactDataTableColumn, TableInstance } from "@datatablex/react";

interface Row {
  id: number;
  name: string;
}

const rows: Row[] = [
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" },
  { id: 3, name: "Carol" },
];

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID" },
  { key: "name", title: "Name", searchable: true },
];

function TableFromOptions(props: { dataSource: DataSource<Row>; searchable?: boolean; selectable?: boolean }) {
  return <DataTable dataSource={props.dataSource} columns={columns} rowKey="id" searchable={props.searchable} selectable={props.selectable} />;
}

describe("<DataTable> — options form", () => {
  it("renders rows fetched from a local data source", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    render(<TableFromOptions dataSource={dataSource} />);

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("filters rows via the debounced search box", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    render(<TableFromOptions dataSource={dataSource} searchable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    const input = screen.getByPlaceholderText("Search...");
    await user.type(input, "carol");

    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("shows row selection checkboxes when selectable", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    render(<TableFromOptions dataSource={dataSource} selectable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThan(rows.length); // header "select all" + one per row
  });

  it("shows the empty state when there are no rows", async () => {
    const dataSource = createLocalDataSource<Row>([], columns);
    render(<TableFromOptions dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("No records found")).toBeInTheDocument());
  });

  /**
   * In the shorthand `<DataTable dataSource={...}>` form the caller has no
   * access to `reload()`, so a changed `dataSource` must be queried on its own.
   */
  it("queries the NEW dataSource when dataSourceKey changes in the shorthand form", async () => {
    const sourceA = createLocalDataSource<Row>([{ id: 1, name: "A-Alice" }], columns);
    const sourceB = createLocalDataSource<Row>([{ id: 2, name: "B-Bob" }], columns);
    function Harness({ dataSource, dataSourceKey }: { dataSource: DataSource<Row>; dataSourceKey: string }) {
      return <DataTable dataSource={dataSource} dataSourceKey={dataSourceKey} columns={columns} rowKey="id" />;
    }
    const { rerender } = render(<Harness dataSource={sourceA} dataSourceKey="a" />);
    await waitFor(() => expect(screen.getByText("A-Alice")).toBeInTheDocument());

    rerender(<Harness dataSource={sourceB} dataSourceKey="b" />);
    await waitFor(() => expect(screen.getByText("B-Bob")).toBeInTheDocument());
    expect(screen.queryByText("A-Alice")).not.toBeInTheDocument();
  });
});

describe("<DataTable> — table instance form", () => {
  function TableFromInstance({ dataSource }: { dataSource: DataSource<Row> }) {
    const table = useDataTable({ dataSource, columns, rowKey: "id" });
    return <DataTable table={table} />;
  }

  it("renders using a pre-built TableInstance without a separate columns prop", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    render(<TableFromInstance dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
  });

  it("renders the default error state and recovers via reload()", async () => {
    let shouldFail = true;
    const dataSource: DataSource<Row> = {
      fetch: () => (shouldFail ? Promise.reject(new Error("network down")) : Promise.resolve({ data: rows, pagination: { page: 1, pageSize: 20, total: rows.length } })),
    };
    render(<TableFromInstance dataSource={dataSource} />);

    await waitFor(() => expect(screen.getByText("Something went wrong")).toBeInTheDocument());
    expect(screen.getByText("network down")).toBeInTheDocument();

    shouldFail = false;
    const user = userEvent.setup();
    await user.click(screen.getByText("Retry"));

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
  });
});

/**
 * The search box must follow `table.search` after the first render: a `reset()`
 * that comes from outside the table has to clear the box as well.
 */
describe("<DataTable> — search box external sync", () => {
  function TableWithExternalControls({ dataSource }: { dataSource: DataSource<Row> }) {
    const table = useDataTable({ dataSource, columns, rowKey: "id" });
    return (
      <>
        <button onClick={() => table.reset()}>Clear Filters</button>
        <button onClick={() => table.setSearch("bob")}>Search Programmatically</button>
        <DataTable table={table} searchable />
      </>
    );
  }

  it("clears the search box when reset() is called from outside the table", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    render(<TableWithExternalControls dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    const input = screen.getByPlaceholderText("Search...") as HTMLInputElement;
    await user.type(input, "carol");
    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(input.value).toBe("carol");

    await user.click(screen.getByText("Clear Filters"));

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(input.value).toBe(""); // the box is in sync with the table
  });

  it("reflects a programmatic setSearch in the search box", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    render(<TableWithExternalControls dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Search Programmatically"));

    const input = screen.getByPlaceholderText("Search...") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("bob"));
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  /**
   * Even when a hand-built `TableInstance` does not bump `searchRevision`, an
   * external `search` change is reflected in the search box (value dependency).
   */
  it("reflects an external search change in the search box of a hand-built TableInstance", async () => {
    function Harness() {
      const [search, setSearch] = useState("initial");
      const table: TableInstance<Row> = {
        data: [],
        loading: false,
        error: null,
        pagination: { current: 1, pageSize: 20, total: 0, onChange: () => {} },
        sorting: [],
        setSorting: () => {},
        filters: null,
        setFilters: () => {},
        lockedFilters: null,
        search,
        setSearch,
        selectedRowKeys: [],
        setSelectedRowKeys: () => {},
        columnState: [],
        setColumnState: () => {},
        resetColumns: () => {},
        density: "middle",
        setDensity: () => {},
        headerDensity: "middle",
        setHeaderDensity: () => {},
        reload: () => Promise.resolve(),
        reset: () => {},
        exportData: () => Promise.resolve("started" as const),
        cancelExport: () => {},
        isExporting: false,
        exportProgress: null,
        exportFormats: ["csv"],
        columns,
        rowKey: "id",
        tableId: undefined,
        limits: { maxSearchLength: 200, maxFilterCount: null, maxFilterDepth: null, maxInValues: null },
        searchRevision: 0,
      };
      return (
        <>
          <button onClick={() => setSearch("external")}>Search Externally</button>
          <DataTable table={table} searchable />
        </>
      );
    }

    render(<Harness />);
    const input = screen.getByPlaceholderText("Search...") as HTMLInputElement;
    expect(input.value).toBe("initial");

    fireEvent.click(screen.getByText("Search Externally"));

    await waitFor(() => expect(input.value).toBe("external"));
  });

  /**
   * Everything needed for rendering is part of the public contract: a
   * hand-built instance that fully implements the public type must render its
   * columns and row keys.
   */
  it("renders the columns and row keys of a hand-built TableInstance that implements the public contract", () => {
    const warnSpy = vi.spyOn(console, "warn");
    const noop = () => {};
    const table: TableInstance<Row> = {
      data: rows,
      loading: false,
      error: null,
      pagination: { current: 1, pageSize: 20, total: rows.length, onChange: noop },
      sorting: [],
      setSorting: noop,
      filters: null,
      setFilters: noop,
      lockedFilters: null,
      search: "",
      setSearch: noop,
      selectedRowKeys: [],
      setSelectedRowKeys: noop,
      columnState: columns.map((c, order) => ({ key: c.key, order })),
      setColumnState: noop,
      resetColumns: noop,
      density: "middle",
      setDensity: noop,
      headerDensity: "middle",
      setHeaderDensity: noop,
      reload: () => Promise.resolve(),
      reset: noop,
      exportData: () => Promise.resolve("started" as const),
      cancelExport: noop,
      isExporting: false,
      exportProgress: null,
      exportFormats: ["csv"],
      columns,
      rowKey: "id",
      tableId: undefined,
      limits: { maxSearchLength: 200, maxFilterCount: null, maxFilterDepth: null, maxInValues: null },
      searchRevision: 0,
    };
    const { container } = render(<DataTable table={table} />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect([...container.querySelectorAll("tr[data-row-key]")].map((tr) => tr.getAttribute("data-row-key"))).toEqual(["1", "2", "3"]);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("rowKey is missing"));
    warnSpy.mockRestore();
  });

  /**
   * If `reset()` is called before the debounce window (300ms) elapses,
   * `table.search` is `""` both before and after the reset, so the change does
   * not look like it came from outside; the pending keystroke must not silently
   * undo the "Clear Filters" action.
   */
  it("does NOT bring back a pending search when reset() is called before the debounce elapses", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    render(<TableWithExternalControls dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const input = screen.getByPlaceholderText("Search...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "pending" } });
    fireEvent.click(screen.getByText("Clear Filters"));

    // Wait until the debounce time (300ms) has passed; this is the point where
    // the pending "pending" value would be written back to the table/input.
    await new Promise((r) => setTimeout(r, 400));

    expect(input.value).toBe("");
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });
});

describe("<DataTable> — column management and density", () => {
  interface WideRow {
    id: number;
    name: string;
    age: number;
  }

  const wideRows: WideRow[] = [
    { id: 1, name: "Alice", age: 30 },
    { id: 2, name: "Bob", age: 25 },
  ];

  const wideColumns: ReactDataTableColumn<WideRow>[] = [
    { key: "id", title: "ID", width: 80 },
    { key: "name", title: "Name" },
    { key: "age", title: "Age" },
  ];

  afterEach(() => {
    window.localStorage.clear();
  });

  function TableWithInstance({ dataSource, columnManagement }: { dataSource: DataSource<WideRow>; columnManagement?: boolean }) {
    const table = useDataTable({ dataSource, columns: wideColumns, rowKey: "id" });
    return (
      <>
        <button onClick={() => table.setColumnState(table.columnState.map((c) => (c.key === "name" ? { ...c, hidden: true } : c)))}>
          Hide Name
        </button>
        <button onClick={() => table.setDensity("small")}>Compact</button>
        <div data-testid="id-width">{table.columnState.find((c) => c.key === "id")?.width}</div>
        <DataTable table={table} columnManagement={columnManagement} />
      </>
    );
  }

  it("does NOT render the header and cells of a column whose columnState.hidden is true", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    render(<TableWithInstance dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.getByText("Name")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText("Hide Name"));

    await waitFor(() => expect(screen.queryByText("Name")).not.toBeInTheDocument());
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument(); // the age column is still visible
  });

  it("the Ant Design Table gets the small size class when density changes", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    const { container } = render(<TableWithInstance dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(container.querySelector(".ant-table-middle")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText("Compact"));
    await waitFor(() => expect(container.querySelector(".ant-table-small")).toBeInTheDocument());
  });

  it("columnManagement panel: a checkbox hides the column", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    render(<TableWithInstance dataSource={dataSource} columnManagement />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("Name"));

    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument());
  });

  it("columnManagement panel: the down button moves the column to the next position", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    const { container } = render(<TableWithInstance dataSource={dataSource} columnManagement />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const headersBefore = Array.from(container.querySelectorAll("th")).map((th) => th.textContent);
    expect(headersBefore).toEqual(["ID", "Name", "Age"]);

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("Move ID down"));

    await waitFor(() => {
      const headersAfter = Array.from(container.querySelectorAll("th")).map((th) => th.textContent);
      expect(headersAfter).toEqual(["Name", "ID", "Age"]);
    });
  });

  it("resetColumns(): Reset View in the panel brings back the hidden column", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    render(<TableWithInstance dataSource={dataSource} columnManagement />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Hide Name"));
    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument());

    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByText("Reset View"));

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
  });

  it("dragging the resize handle in the header updates columnState.width", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    const { container } = render(<TableWithInstance dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.getByTestId("id-width").textContent).toBe("80");

    const handle = container.querySelector('[data-testid="resize-handle-id"]')!;
    expect(handle).toBeTruthy();

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 160 });
    fireEvent.mouseUp(document, { clientX: 160 });

    await waitFor(() => expect(screen.getByTestId("id-width").textContent).toBe("140")); // 80 + (160 - 100)
  });

  it("the resize handle spans the whole table (header + rows), not just the header cell", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    // jsdom has no layout: fake the measurement for the table element.
    const original = HTMLTableElement.prototype.getBoundingClientRect;
    HTMLTableElement.prototype.getBoundingClientRect = () => ({ height: 320, width: 500, top: 0, left: 0, right: 500, bottom: 320, x: 0, y: 0, toJSON: () => ({}) });
    try {
      render(<TableWithInstance dataSource={dataSource} />);
      await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId("resize-handle-id")).toHaveStyle({ height: "320px" }));
      // For `ellipsis` columns Ant Design makes the header cell `overflow: hidden`; the handle must not be clipped.
      expect(screen.getByTestId("resize-handle-id").closest("th")).toHaveStyle({ overflow: "visible" });
    } finally {
      HTMLTableElement.prototype.getBoundingClientRect = original;
    }
  });

  it("the handle keeps the cell height when the table height cannot be measured", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    render(<TableWithInstance dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.getByTestId("resize-handle-id")).toHaveStyle({ height: "100%" });
  });

  /**
   * The resize handle is a focusable `role="separator"` and can be resized
   * from the keyboard with the arrow keys.
   */
  it("the resize handle can be resized with the keyboard (arrow keys)", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    render(<TableWithInstance dataSource={dataSource} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.getByTestId("id-width").textContent).toBe("80");

    const handle = screen.getByTestId("resize-handle-id");
    expect(handle).toHaveAttribute("role", "separator");
    expect(handle).toHaveAttribute("tabIndex", "0");

    const user = userEvent.setup();
    handle.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByTestId("id-width").textContent).toBe("90"));

    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    await waitFor(() => expect(screen.getByTestId("id-width").textContent).toBe("70"));
  });

  /**
   * The handle is a child of the `<th>`: unless the handle's own `onClick`
   * calls `stopPropagation()`, a click could bubble up and trigger the sort
   * menu on the column header.
   */
  it("clicking the resize handle does NOT trigger sorting on a sortable column", async () => {
    const sortableColumns: ReactDataTableColumn<WideRow>[] = [
      { key: "id", title: "ID", width: 80, sortable: true },
      { key: "name", title: "Name" },
      { key: "age", title: "Age" },
    ];
    const dataSource = createLocalDataSource(wideRows, sortableColumns);
    let table!: TableInstance<WideRow>;
    function Harness() {
      const t = useDataTable({ dataSource, columns: sortableColumns, rowKey: "id" });
      table = t;
      return <DataTable table={t} />;
    }
    const { container } = render(<Harness />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(table.sorting).toEqual([]);

    const handle = container.querySelector('[data-testid="resize-handle-id"]')!;
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 160 });
    fireEvent.mouseUp(document, { clientX: 160 });
    // In a real browser mousedown+mouseup on the same element produces a click.
    fireEvent.click(handle);

    await waitFor(() => expect(table.columnState.find((c) => c.key === "id")?.width).toBe(140));
    expect(table.sorting).toEqual([]);
  });

  /**
   * When no `scroll` is given to `<Table>`, rc-table picks `tableLayout: "auto"`,
   * and in that mode `fixed` columns are never pinned.
   */
  it("fixed column: scroll.x is provided and the ant-table-fixed-column class is applied", async () => {
    const fixedColumns: ReactDataTableColumn<WideRow>[] = [
      { key: "id", title: "ID", width: 80, fixed: "left" },
      { key: "name", title: "Name" },
      { key: "age", title: "Age" },
    ];
    const dataSource = createLocalDataSource(wideRows, fixedColumns);
    function Harness() {
      const table = useDataTable({ dataSource, columns: fixedColumns, rowKey: "id" });
      return <DataTable table={table} />;
    }
    const { container } = render(<Harness />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    expect(container.querySelector(".ant-table-has-fix-left")).toBeInTheDocument();
    expect(container.querySelector(".ant-table-fixed-column")).toBeInTheDocument();
    expect(container.querySelector(".ant-table")?.className).toContain("ant-table-scroll-horizontal");
  });

  /**
   * In Ant Design, pinning a fixed column depends on the column order: moving a
   * left-fixed column behind a normal column in the panel would make the sticky
   * layer and the panel order diverge.
   */
  it("a fixed:'left' column can NOT be moved behind a normal column in the panel", async () => {
    const fixedFirstColumns: ReactDataTableColumn<WideRow>[] = [
      { key: "id", title: "ID", fixed: "left" },
      { key: "name", title: "Name" },
      { key: "age", title: "Age" },
    ];
    const dataSource = createLocalDataSource(wideRows, fixedFirstColumns);
    function Harness() {
      const table = useDataTable({ dataSource, columns: fixedFirstColumns, rowKey: "id" });
      return <DataTable table={table} columnManagement />;
    }
    const { container } = render(<Harness />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));

    const moveDown = screen.getByLabelText("Move ID down");
    expect(moveDown).toBeDisabled();
    fireEvent.click(moveDown); // disabled: it must have no effect

    const headers = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(headers).toEqual(["ID", "Name", "Age"]);
  });

  it("columns in the same fixed region can be moved freely relative to each other", async () => {
    const twoLeftFixed: ReactDataTableColumn<WideRow>[] = [
      { key: "id", title: "ID", fixed: "left" },
      { key: "age", title: "Age", fixed: "left" },
      { key: "name", title: "Name" },
    ];
    const dataSource = createLocalDataSource(wideRows, twoLeftFixed);
    function Harness() {
      const table = useDataTable({ dataSource, columns: twoLeftFixed, rowKey: "id" });
      return <DataTable table={table} columnManagement />;
    }
    const { container } = render(<Harness />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("Move ID down"));

    await waitFor(() => {
      const headers = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
      expect(headers).toEqual(["Age", "ID", "Name"]);
    });
  });

  /**
   * A late `mouseup` after the component was unmounted in the middle of a drag
   * must not stay bound to `document` and must not write to localStorage.
   */
  it("a late mouseup after unmounting mid-drag does NOT write to localStorage", async () => {
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    function Harness() {
      const table = useDataTable({ dataSource, columns: wideColumns, rowKey: "id", tableId: "unmount-resize" });
      return <DataTable table={table} />;
    }
    const { container, unmount } = render(<Harness />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const handle = container.querySelector('[data-testid="resize-handle-id"]')!;
    fireEvent.mouseDown(handle, { clientX: 100 });
    unmount();
    fireEvent.mouseUp(document, { clientX: 300 });

    expect(window.localStorage.getItem("datatablex:columns:unmount-resize")).toBeNull();
  });

  /**
   * If the last visible column could be hidden too, the table would look empty
   * while it has data, and with a `tableId` that state would be persisted.
   */
  it("the checkbox of the last visible column is disabled in the panel: not all columns can be hidden", async () => {
    const twoColumns: ReactDataTableColumn<WideRow>[] = [
      { key: "id", title: "ID" },
      { key: "name", title: "Name" },
    ];
    const dataSource = createLocalDataSource(wideRows, twoColumns);
    function Harness() {
      const table = useDataTable({ dataSource, columns: twoColumns, rowKey: "id" });
      return <DataTable table={table} columnManagement />;
    }
    const { container } = render(<Harness />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    // This test relies precisely on the `pointer-events` check (a click on the
    // disabled checkbox is REJECTED); the global opt-out in the setup is turned
    // back on here (see vitest.setup.ts).
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.EachApiCall });
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("ID"));
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["Name"]),
    );

    // userEvent REJECTS the click because the checkbox is `disabled`; that is the guard itself.
    const lastCheckbox = screen.getByLabelText("Name");
    expect(lastCheckbox).toBeDisabled();
    await expect(user.click(lastCheckbox)).rejects.toThrow(/pointer-events/);

    expect(Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["Name"]);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  /**
   * Moving a visible column past a hidden neighbour would change `order` but
   * produce no visible effect in the table.
   */
  it("the down button SKIPS hidden columns and moves to the next visible column", async () => {
    const threeColumns: ReactDataTableColumn<WideRow>[] = [
      { key: "id", title: "ID" },
      { key: "name", title: "Name", defaultHidden: true },
      { key: "age", title: "Age" },
    ];
    const dataSource = createLocalDataSource(wideRows, threeColumns);
    function Harness() {
      const table = useDataTable({ dataSource, columns: threeColumns, rowKey: "id" });
      return <DataTable table={table} columnManagement />;
    }
    const { container } = render(<Harness />);
    // "Name" is defaultHidden, so "Alice" is never rendered; we tell that
    // loading has finished from the "age" cell.
    await waitFor(() => expect(screen.getByText("30")).toBeInTheDocument());

    const headersBefore = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(headersBefore).toEqual(["ID", "Age"]); // "Name" is defaultHidden

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("Move ID down"));

    await waitFor(() => {
      const headersAfter = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
      expect(headersAfter).toEqual(["Age", "ID"]); // the hidden "Name" was skipped and it took the place of "Age" directly
    });
  });

  /**
   * `columnState` is a value DERIVED from the `columns` prop; computing it only
   * in the `useState` initializer would leave it stale when `columns` changes
   * at runtime.
   */
  it("reflects a new or removed column correctly in the header order and the panel when the columns prop changes at runtime", async () => {
    const colsA: ReactDataTableColumn<WideRow>[] = [
      { key: "id", title: "ID" },
      { key: "age", title: "Age" },
    ];
    const colsB: ReactDataTableColumn<WideRow>[] = [
      { key: "id", title: "ID" },
      { key: "age", title: "Age" },
      { key: "name", title: "Name" },
    ];
    const dataSource = createLocalDataSource(wideRows, colsB);
    function Harness({ columns }: { columns: ReactDataTableColumn<WideRow>[] }) {
      const table = useDataTable({ dataSource, columns, rowKey: "id" });
      return <DataTable table={table} columnManagement />;
    }
    const { container, rerender } = render(<Harness columns={colsA} />);
    // colsA does not contain "name"; we tell that loading has finished from the "age" cell.
    await waitFor(() => expect(screen.getByText("30")).toBeInTheDocument());

    rerender(<Harness columns={colsB} />);
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["ID", "Age", "Name"]),
    );

    rerender(<Harness columns={colsA} />);
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["ID", "Age"]),
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    expect(screen.queryByRole("checkbox", { name: "Name" })).not.toBeInTheDocument(); // no ghost row is left
  });

  /**
   * Reading localStorage in the `useState` initializer would cause a silent
   * hydration mismatch in SSR: the server (no window) renders the default,
   * while the client would render the saved state on its first render.
   * `renderToString` RUNS no effects, so it is equivalent to the client's first
   * render before hydration; both (window present/absent) must render the
   * default.
   */
  it("SSR: the server output and the client's FIRST render output match when a localStorage entry exists", () => {
    window.localStorage.setItem(
      "datatablex:columns:ssr-t",
      JSON.stringify({
        schemaVersion: 1,
        columnState: [
          { key: "id", order: 0 },
          { key: "name", order: 1, hidden: true },
          { key: "age", order: 2 },
        ],
      }),
    );
    const dataSource = createLocalDataSource(wideRows, wideColumns);
    function Harness() {
      const table = useDataTable({ dataSource, columns: wideColumns, rowKey: "id", tableId: "ssr-t" });
      return <DataTable table={table} />;
    }

    // The choice of `useIsomorphicLayoutEffect` in `useDataTable.ts` is made
    // ONCE at module load time. Because this test file is imported in jsdom
    // while `window` already exists, the choice is fixed to `useLayoutEffect`;
    // deleting `globalThis.window` below (to imitate real SSR) cannot change it
    // retroactively. As a result `renderToString`, whether server or
    // client-first-pass and even though neither runs `useLayoutEffect`, emits
    // React's harmless "does nothing on the server" warning; in real SSR the
    // module is loaded without any `window`, so this warning does not occur.
    // It is only an artifact of the test technique, so BOTH calls are silenced.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const realWindow = globalThis.window;
    // @ts-expect-error imitates the server environment for this measurement only: there is NO window
    delete globalThis.window;
    let serverHtml = "";
    expect(() => {
      serverHtml = renderToString(<Harness />);
    }).not.toThrow();
    globalThis.window = realWindow;

    const clientFirstPassHtml = renderToString(<Harness />);
    consoleErrorSpy.mockRestore();

    expect(serverHtml).toContain(">Name<"); // the default is rendered DESPITE hidden:true in localStorage
    expect(clientFirstPassHtml).toContain(">Name<"); // the client's FIRST render is the same: no mismatch
  });
});

/**
 * The error view does NOT remove the table: on a client-caused 400 the user
 * must still be able to reach the toolbar and the header menus to fix the
 * faulty query.
 */
describe("<DataTable> — non-locking error view", () => {
  function failingOnSearch(): DataSource<Row> {
    const local = createLocalDataSource(rows, columns);
    return {
      fetch: (query, options) =>
        query.search
          ? Promise.reject(new DataTableRequestError("search can be at most 3 characters", 400, null))
          : local.fetch(query, options),
    };
  }

  it("on a 4xx the toolbar stays, 'Retry' is hidden and 'Clear Query' rescues the table", async () => {
    const dataSource = failingOnSearch();
    render(<DataTable dataSource={dataSource} columns={columns} rowKey="id" searchable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search..."), "carol");
    await waitFor(() => expect(screen.getByText("search can be at most 3 characters")).toBeInTheDocument(), { timeout: 2000 });

    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    expect(screen.getByTestId("column-header-trigger-name")).toBeInTheDocument();
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();

    await user.click(screen.getByText("Clear Query"));
    await waitFor(() => expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument());
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search...")).toHaveValue("");
  });

  it("maxSearchLength truncates the search box and a programmatic setSearch", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    let tableRef: TableInstance<Row> | undefined;
    function Harness() {
      const table = useDataTable({ dataSource, columns, rowKey: "id", maxSearchLength: 5 });
      tableRef = table;
      return <DataTable table={table} searchable />;
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    expect(screen.getByPlaceholderText("Search...")).toHaveAttribute("maxlength", "5");
    act(() => tableRef!.setSearch("bob-long-term"));
    await waitFor(() => expect(tableRef!.search).toBe("bob-l"));
  });
});

describe("<DataTable> — selection counter", () => {
  it("the counter is visible while there is a selection, 'Clear Selection' resets it", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    render(<TableFromOptions dataSource={dataSource} selectable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.queryByTestId("selection-summary")).not.toBeInTheDocument();

    const user = userEvent.setup();
    const [, firstRow, secondRow] = screen.getAllByRole("checkbox");
    await user.click(firstRow!);
    await user.click(secondRow!);
    await waitFor(() => expect(screen.getByText("2 selected")).toBeInTheDocument());

    await user.click(screen.getByText("Clear Selection"));
    await waitFor(() => expect(screen.queryByTestId("selection-summary")).not.toBeInTheDocument());
  });
});

describe("<DataTable> — hiding the selection column from column management", () => {
  const TABLE_ID = "selection-column-test";

  afterEach(() => window.localStorage.clear());

  function SelectableManagedTable() {
    const [dataSource] = useState(() => createLocalDataSource(rows, columns));
    return <DataTable dataSource={dataSource} columns={columns} rowKey="id" tableId={TABLE_ID} selectable columnManagement />;
  }

  const rowCheckboxCount = (container: HTMLElement) => container.querySelectorAll("tbody .ant-checkbox-input").length;

  it("the panel has a 'Selection' row; unchecking it hides the checkbox column and keeps the selection", async () => {
    const { container } = render(<SelectableManagedTable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(rowCheckboxCount(container)).toBe(rows.length);

    const user = userEvent.setup();
    await user.click(container.querySelectorAll<HTMLInputElement>("tbody .ant-checkbox-input")[0]!);
    await waitFor(() => expect(screen.getByText("1 selected")).toBeInTheDocument());

    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("Selection"));
    await waitFor(() => expect(rowCheckboxCount(container)).toBe(0));
    expect(container.querySelectorAll("thead .ant-checkbox-input")).toHaveLength(0);
    expect(screen.getByText("1 selected")).toBeInTheDocument(); // hiding does not clear the selection

    await user.click(screen.getByLabelText("Selection"));
    await waitFor(() => expect(rowCheckboxCount(container)).toBe(rows.length));
  });

  it("the hidden state persists with tableId; 'Reset View' brings the column back", async () => {
    const first = render(<SelectableManagedTable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("Selection"));
    await waitFor(() => expect(rowCheckboxCount(first.container)).toBe(0));
    first.unmount();

    const second = render(<SelectableManagedTable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(rowCheckboxCount(second.container)).toBe(0);

    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByText("Reset View"));
    await waitFor(() => expect(rowCheckboxCount(second.container)).toBe(rows.length));
  });

  it("a non-selectable table has no 'Selection' row in the panel", async () => {
    const dataSource = createLocalDataSource(rows, columns);
    render(<DataTable dataSource={dataSource} columns={columns} rowKey="id" columnManagement />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    expect(screen.queryByLabelText("Selection")).not.toBeInTheDocument();
  });
});

describe("<DataTable> — 'No' (row number) virtual column", () => {
  const TABLE_ID = "row-number-column-test";

  afterEach(() => window.localStorage.clear());

  function NumberedTable(props: { selectable?: boolean }) {
    const [dataSource] = useState(() => createLocalDataSource(rows, columns));
    return <DataTable dataSource={dataSource} columns={columns} rowKey="id" tableId={TABLE_ID} columnManagement selectable={props.selectable} />;
  }

  const numberCells = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("tbody tr")).map((tr) => tr.querySelector("td:not(.ant-table-selection-column)")?.textContent);

  it("is hidden by default", async () => {
    render(<NumberedTable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.queryByRole("columnheader", { name: "No" })).not.toBeInTheDocument();
  });

  it("when turned on from the panel, rows are numbered 1..n; the header has no sort/wrap menu", async () => {
    const { container } = render(<NumberedTable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("No"));
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "No" })).toBeInTheDocument());
    expect(numberCells(container)).toEqual(["1", "2", "3"]);
    expect(screen.queryByTestId("column-header-trigger-__datatablex_row_number")).not.toBeInTheDocument();
  });

  it("numbers continue across pages: page 2 (default page size 20) starts at 21", async () => {
    const many: Row[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `Record ${i + 1}` }));
    function ManyRowsTable() {
      const [dataSource] = useState(() => createLocalDataSource(many, columns));
      return <DataTable dataSource={dataSource} columns={columns} rowKey="id" tableId={TABLE_ID} columnManagement />;
    }
    const { container } = render(<ManyRowsTable />);
    await waitFor(() => expect(screen.getByText("Record 1")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("No"));
    await waitFor(() => expect(numberCells(container)[0]).toBe("1"));

    await user.click(screen.getByTitle("2"));
    await waitFor(() => expect(screen.getByText("Record 21")).toBeInTheDocument());
    expect(numberCells(container)).toEqual(["21", "22", "23", "24", "25"]);
  });

  it("when the selection column is on, 'No' is placed to its left too", async () => {
    const { container } = render(<NumberedTable selectable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("No"));
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "No" })).toBeInTheDocument());

    const firstRowCells = Array.from(container.querySelectorAll("tbody tr")[0]!.querySelectorAll("td"));
    expect(firstRowCells[0]?.textContent).toBe("1");
    expect(firstRowCells[1]?.classList.contains("ant-table-selection-column")).toBe(true);
  });

  it("visibility persists with tableId; 'Reset View' hides the column again", async () => {
    const first = render(<NumberedTable />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByLabelText("No"));
    await waitFor(() => expect(numberCells(first.container)).toEqual(["1", "2", "3"]));
    first.unmount();

    const second = render(<NumberedTable />);
    await waitFor(() => expect(numberCells(second.container)).toEqual(["1", "2", "3"]));

    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByText("Reset View"));
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "No" })).not.toBeInTheDocument());
  });
});

describe("<DataTable> — column header menu accessibility", () => {
  it("sort labels are chosen by column type", () => {
    expect(sortLabelsFor({ key: "a", title: "A", type: "text" })).toEqual({ asc: "A → Z", desc: "Z → A" });
    expect(sortLabelsFor({ key: "a", title: "A", type: "currency" })).toEqual({ asc: "smallest to largest", desc: "largest to smallest" });
    expect(sortLabelsFor({ key: "a", title: "A", type: "datetime" })).toEqual({ asc: "oldest to newest", desc: "newest to oldest" });
  });

  it("the trigger carries aria-expanded; Escape closes the sub-panel first, then the menu", async () => {
    const sortableColumns: ReactDataTableColumn<Row>[] = [
      { key: "id", title: "ID", type: "number", sortable: true },
      { key: "name", title: "Name" },
    ];
    const dataSource = createLocalDataSource(rows, sortableColumns);
    render(<DataTable dataSource={dataSource} columns={sortableColumns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    const trigger = screen.getByTestId("column-header-trigger-id");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));

    await user.click(await screen.findByRole("menuitem", { name: /Sort/ }));
    const ascending = await screen.findByRole("menuitemradio", { name: /smallest to largest/ });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(ascending).not.toBeInTheDocument());
    expect(await screen.findByRole("menuitem", { name: /Sort/ })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  });

  it("the sub-panel opens to the RIGHT of the main menu; the main menu stays visible and the row carries aria-expanded", async () => {
    const menuColumns: ReactDataTableColumn<Row>[] = [
      { key: "id", title: "ID", type: "number", sortable: true, filterable: true },
      { key: "name", title: "Name" },
    ];
    render(<DataTable dataSource={createLocalDataSource(rows, menuColumns)} columns={menuColumns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("column-header-trigger-id"));
    const sortRow = await screen.findByRole("menuitem", { name: /Sort/ });
    await user.click(sortRow);

    expect(await screen.findByRole("menu", { name: "Sort" })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "ID column menu" })).toBeInTheDocument();
    expect(sortRow).toHaveAttribute("aria-expanded", "true");

    // Clicking the same row a second time closes the sub-panel.
    await user.click(sortRow);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Sort" })).not.toBeInTheDocument());
    expect(sortRow).toHaveAttribute("aria-expanded", "false");
  });

  it("keyboard: down navigates, right opens and focuses the sub-panel, left returns focus to the row that opened it", async () => {
    const menuColumns: ReactDataTableColumn<Row>[] = [
      { key: "id", title: "ID", type: "number", sortable: true, filterable: true },
      { key: "name", title: "Name" },
    ];
    render(<DataTable dataSource={createLocalDataSource(rows, menuColumns)} columns={menuColumns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("column-header-trigger-id"));
    const filterRow = await screen.findByRole("menuitem", { name: /Filter/ });
    await waitFor(() => expect(filterRow).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    const sortRow = screen.getByRole("menuitem", { name: /Sort/ });
    expect(sortRow).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    const ascending = await screen.findByRole("menuitemradio", { name: /smallest to largest/ });
    await waitFor(() => expect(ascending).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: /largest to smallest/ })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(ascending).not.toBeInTheDocument());
    await waitFor(() => expect(sortRow).toHaveFocus());
  });
});
