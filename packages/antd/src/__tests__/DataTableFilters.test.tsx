import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import type { DataSource, DataTableQuery, DataTableResult } from "@datatablex/core";
import { DataTable } from "../DataTable.js";
import { useDataTable } from "@datatablex/react";
import { createLocalDataSource } from "@datatablex/react";
import type { ReactDataTableColumn } from "@datatablex/react";

/**
 * The filter bar is the single filter interface: for every column type, the
 * end-to-end flow from the "Filter" shortcut in the header menu to the bar
 * editor. Rule model details are in `FilterBar.test.tsx` and in the react
 * package's `filterRules.test.ts`.
 */

interface Row {
  id: number;
  name: string;
  amount: number;
  createdAt: string;
  status: string;
  active: boolean;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "name", title: "Name", type: "text", filterable: true },
  { key: "amount", title: "Amount", type: "currency", currency: "TRY", filterable: true },
  { key: "createdAt", title: "Date", type: "datetime", timezone: "Europe/Istanbul", filterable: true },
  {
    key: "status",
    title: "Status",
    type: "enum",
    filterable: true,
    options: [
      { label: "Open", value: "open" },
      { label: "Closed", value: "closed" },
    ],
  },
  { key: "active", title: "Active", type: "boolean", filterable: true },
];

const rows: Row[] = [
  { id: 1, name: "Alice", amount: 100, createdAt: "2026-09-01T10:00:00.000Z", status: "open", active: true },
  { id: 2, name: "Bernard", amount: 250, createdAt: "2026-09-05T10:00:00.000Z", status: "closed", active: false },
  { id: 3, name: "Maya", amount: 500, createdAt: "2026-09-09T10:00:00.000Z", status: "open", active: true },
];

/** A source that records the `DataTableQuery` objects it receives and delegates the rest to `queryInMemory`. */
function recordingSource(data: Row[] = rows): { source: DataSource<Row>; queries: DataTableQuery[] } {
  const local = createLocalDataSource(data, columns);
  const queries: DataTableQuery[] = [];
  return {
    queries,
    source: {
      fetch(query: DataTableQuery, options?: { signal?: AbortSignal }): Promise<DataTableResult<Row>> {
        queries.push(structuredClone(query));
        return local.fetch(query, options);
      },
    },
  };
}

/** Header menu -> "Filter": opens the rule editor in the bar with the field preselected. */
async function openFilter(user: UserEvent, key: string) {
  await user.click(screen.getByTestId(`column-header-trigger-${key}`));
  await user.click(await screen.findByRole("menuitem", { name: /Filter/ }));
}

async function chooseOperator(user: UserEvent, option: string) {
  await user.click(screen.getByRole("combobox", { name: "Condition" }));
  const options = await screen.findAllByTitle(option);
  await user.click(options[options.length - 1]!);
}

const apply = (user: UserEvent) => user.click(screen.getByRole("button", { name: "Apply" }));
const bar = () => screen.getByRole("group", { name: "Filters" });
const lastQuery = (queries: DataTableQuery[]) => queries[queries.length - 1]!;

describe("<DataTable> — the filter bar as the single interface", () => {
  it("shows the bar by default when a column is filterable; filterBar={false} hides it", async () => {
    const { source } = recordingSource();
    const { unmount } = render(<DataTable dataSource={source} columns={columns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(bar()).toBeInTheDocument();
    unmount();

    render(<DataTable dataSource={source} columns={columns} rowKey="id" filterBar={false} />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "Filters" })).not.toBeInTheDocument();
    // Without the filter interface, the header menu has no "Filter" item either.
    await userEvent.setup().click(screen.getByTestId("column-header-trigger-name"));
    await screen.findByRole("menu", { name: /Name/ });
    expect(screen.queryByRole("menuitem", { name: /Filter/ })).not.toBeInTheDocument();
  });

  it("does not render the bar when no column is filterable", async () => {
    const plain: ReactDataTableColumn<Row>[] = [
      { key: "id", title: "ID", type: "number" },
      { key: "name", title: "Name", type: "text" },
    ];
    render(<DataTable dataSource={createLocalDataSource(rows, plain)} columns={plain} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("text: produces a contains leaf and narrows the rows", async () => {
    const { source, queries } = recordingSource();
    render(<DataTable dataSource={source} columns={columns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await openFilter(user, "name");
    await user.type(await screen.findByRole("textbox", { name: "Name Value" }), "ay");
    await apply(user);

    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument());
    expect(screen.getByText("Maya")).toBeInTheDocument();
    expect(lastQuery(queries).filters).toEqual({ operator: "AND", filters: [{ field: "name", operator: "contains", value: "ay" }] });
  });

  it("number: a between rule produces a between leaf", async () => {
    const { source, queries } = recordingSource();
    render(<DataTable dataSource={source} columns={columns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await openFilter(user, "amount");
    await chooseOperator(user, "between");
    await user.type(await screen.findByLabelText("Amount min"), "200");
    await user.type(screen.getByLabelText("Amount max"), "300");
    await apply(user);

    await waitFor(() =>
      expect(lastQuery(queries).filters).toEqual({ operator: "AND", filters: [{ field: "amount", operator: "between", value: [200, 300] }] }),
    );
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.getByText("Bernard")).toBeInTheDocument();
  });

  it("boolean: produces an eq leaf", async () => {
    const { source, queries } = recordingSource();
    render(<DataTable dataSource={source} columns={columns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await openFilter(user, "active");
    await user.click(await screen.findByText("No"));
    await apply(user);

    await waitFor(() =>
      expect(lastQuery(queries).filters).toEqual({ operator: "AND", filters: [{ field: "active", operator: "eq", value: false }] }),
    );
  });

  /**
   * Contract constraint: an empty selection does not mean "no rows"
   * (`in: []`); the rule cannot be applied.
   */
  it("enum: the selected values produce an in leaf; Apply is disabled while the selection is empty", async () => {
    const { source, queries } = recordingSource();
    render(<DataTable dataSource={source} columns={columns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await openFilter(user, "status");
    const closed = await screen.findByRole("checkbox", { name: "Closed" });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Open" }));
    expect(closed).not.toBeChecked();
    await apply(user);

    await waitFor(() =>
      expect(lastQuery(queries).filters).toEqual({ operator: "AND", filters: [{ field: "status", operator: "in", value: ["open"] }] }),
    );
  });

  /**
   * Regression: changing the page without changing the filter must not rewrite
   * the filter, otherwise `SET_FILTERS` resets the page to 1.
   */
  it("changing the page does not rewrite an unchanged filter, so the user can paginate", async () => {
    const many: Row[] = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      name: `Item-a-${i + 1}`,
      amount: i,
      createdAt: "2026-09-01T10:00:00.000Z",
      status: "open",
      active: true,
    }));
    const { source, queries } = recordingSource(many);
    render(<DataTable dataSource={source} columns={columns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Item-a-1")).toBeInTheDocument());

    const user = userEvent.setup();
    await openFilter(user, "name");
    await user.type(await screen.findByRole("textbox", { name: "Name Value" }), "item-a");
    await apply(user);
    await waitFor(() => expect(lastQuery(queries).filters).not.toBeNull());

    await user.click(screen.getByTitle("2")); // Ant Design paginator: page 2
    await waitFor(() => expect(screen.getByText("Item-a-21")).toBeInTheDocument());

    const final = lastQuery(queries);
    expect(final.pagination.page).toBe(2);
    expect(final.filters).toEqual({ operator: "AND", filters: [{ field: "name", operator: "contains", value: "item-a" }] });
  });

  it("keeps a filter injected from outside the table; a rule added from the bar is ANDed next to it", async () => {
    const { source, queries } = recordingSource();
    function Harness() {
      const table = useDataTable<Row>({ dataSource: source, columns, rowKey: "id" });
      return (
        <>
          <button type="button" onClick={() => table.setFilters({ operator: "AND", filters: [{ field: "id", operator: "eq", value: 2 }] })}>
            Dashboard filter
          </button>
          <DataTable table={table} />
        </>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText("Dashboard filter"));
    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument());

    await openFilter(user, "name");
    await user.type(await screen.findByRole("textbox", { name: "Name Value" }), "ber");
    await apply(user);

    await waitFor(() =>
      expect(lastQuery(queries).filters).toEqual({
        operator: "AND",
        filters: [
          { field: "id", operator: "eq", value: 2 }, // the injected leaf was KEPT
          { field: "name", operator: "contains", value: "ber" },
        ],
      }),
    );
  });

  it("the toolbar has no separate Clear Filters button", async () => {
    const { source } = recordingSource();
    function Harness() {
      const table = useDataTable<Row>({ dataSource: source, columns, rowKey: "id" });
      return (
        <>
          <button type="button" onClick={() => table.setFilters({ operator: "AND", filters: [{ field: "name", operator: "contains", value: "e" }] })}>
            Set filter
          </button>
          <DataTable table={table} />
        </>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    await userEvent.setup().click(screen.getByText("Set filter"));
    await within(bar()).findByRole("button", { name: "Clear all" });
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("warns once for a filterable column that has no automatic filter", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const withUnsupported: ReactDataTableColumn<Row>[] = [
      { key: "id", title: "ID", type: "number" },
      { key: "status", title: "Status", type: "enum", filterable: true }, // NO options
    ];
    const { source } = recordingSource();
    render(<DataTable dataSource={source} columns={withUnsupported} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("Status")).toBeInTheDocument());

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("An automatic filter could not be generated"));
    // No filterable column is left, so there is no bar either.
    expect(screen.queryByRole("group", { name: "Filters" })).not.toBeInTheDocument();
    warn.mockRestore();
  });

  describe("locked filters", () => {
    const locked = { operator: "AND" as const, filters: [{ field: "status", operator: "in" as const, value: ["open"] }] };

    function LockedHarness({ source, maxRules }: { source: DataSource<Row>; maxRules?: number }) {
      const table = useDataTable<Row>({ dataSource: source, columns, rowKey: "id", lockedFilters: locked });
      return <DataTable table={table} filterBar={maxRules ? { maxRules } : true} />;
    }

    it("appears as a summary that cannot be removed; Clear all does not touch it", async () => {
      const { source, queries } = recordingSource();
      render(<LockedHarness source={source} />);
      await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
      expect(screen.queryByText("Bernard")).not.toBeInTheDocument();

      const chip = within(bar()).getByRole("note", { name: /^Locked filter: Status is any of Open/ });
      expect(within(chip).queryByRole("button")).not.toBeInTheDocument();
      // "Clear all" is not shown while there is no user filter.
      expect(within(bar()).queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();

      const user = userEvent.setup();
      await openFilter(user, "name");
      await user.type(await screen.findByRole("textbox", { name: "Name Value" }), "ay");
      await apply(user);
      await waitFor(() =>
        expect(lastQuery(queries).filters).toEqual({
          operator: "AND",
          filters: [
            { field: "status", operator: "in", value: ["open"] },
            { field: "name", operator: "contains", value: "ay" },
          ],
        }),
      );

      await user.click(within(bar()).getByRole("button", { name: "Clear all" }));
      await waitFor(() => expect(lastQuery(queries).filters).toEqual(locked));
      expect(within(bar()).getByRole("note", { name: /Locked filter/ })).toBeInTheDocument();
    });

    it("locked leaves count against the rule limit", async () => {
      const { source } = recordingSource();
      render(<LockedHarness source={source} maxRules={1} />);
      await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
      expect(within(bar()).getByRole("button", { name: /Add filter/ })).toBeDisabled();
    });
  });
});
