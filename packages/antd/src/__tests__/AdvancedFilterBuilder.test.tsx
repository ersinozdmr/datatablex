import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import type { DataSource, DataTableQuery, FilterGroup } from "@datatablex/core";
import { DataTable } from "../DataTable.js";
import { useDataTable } from "@datatablex/react";
import { createLocalDataSource } from "@datatablex/react";
import type { ReactDataTableColumn, TableInstance } from "@datatablex/react";
import type { FilterBarOptions } from "../types.js";

interface Row {
  id: number;
  name: string;
  amount: number;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "name", title: "Name", type: "text", filterable: true, filterOperators: ["contains", "notContains", "eq"] },
  { key: "amount", title: "Amount", type: "number", filterable: true, filterOperators: ["gt", "lt", "gte", "lte", "between"] },
];

const rows: Row[] = [
  { id: 1, name: "Alice", amount: 100 },
  { id: 2, name: "Bernard", amount: 450 },
  { id: 3, name: "Maya", amount: 500 },
];

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

function Harness({ source, options, onTable }: { source: DataSource<Row>; options: FilterBarOptions; onTable: (t: TableInstance<Row>) => void }) {
  const table = useDataTable({ dataSource: source, columns, rowKey: "id" });
  onTable(table);
  return <DataTable table={table} filterBar={options} />;
}

async function setup(options: FilterBarOptions = { mode: "advanced" }) {
  const { source, queries } = recordingSource();
  let table: TableInstance<Row> | undefined;
  render(<Harness source={source} options={options} onTable={(t) => (table = t)} />);
  await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
  return { queries, table: () => table!, user: userEvent.setup() };
}

/**
 * Opens the Ant Design `Select` through the given combobox element and clicks
 * the visible option. Ant Design's own tests use `mouseDown` instead of
 * user-event's pointer sequence; the builder tests have several selectors per
 * row and would otherwise take tens of seconds.
 */
async function choose(combobox: HTMLElement, option: string) {
  fireEvent.mouseDown(combobox);
  const options = await screen.findAllByTitle(option);
  fireEvent.click(options[options.length - 1]!);
}

const panel = () => screen.getByRole("region", { name: "Advanced" });
const lastCombobox = (name: string) => within(panel()).getAllByRole("combobox", { name }).at(-1)!;
const lastFilters = (queries: DataTableQuery[]) => queries[queries.length - 1]!.filters;

async function openBuilder(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: "Advanced" }));
  return panel();
}

describe("advanced filter builder", () => {
  it("has no Advanced button in simple mode", async () => {
    await setup({ mode: "simple" });
    expect(screen.queryByRole("button", { name: "Advanced" })).not.toBeInTheDocument();
  });

  it("shows the applied nested tree as a draft; the root connective is OR", async () => {
    const { table, user } = await setup();
    act(() =>
      table().setFilters({
        operator: "OR",
        filters: [
          { field: "name", operator: "contains", value: "Al" },
          { operator: "AND", filters: [{ field: "amount", operator: "gt", value: 400 }] },
        ],
      }),
    );
    await openBuilder(user);
    expect(within(panel()).getAllByRole("group", { name: "Group: any condition" })).toHaveLength(1);
    expect(within(panel()).getByRole("group", { name: "Group: all conditions" })).toBeInTheDocument();
    expect(within(panel()).getByRole("textbox", { name: "Name Value" })).toHaveValue("Al");
    expect(within(panel()).getByRole("spinbutton", { name: "Amount Value" })).toHaveValue("400");
  });

  it("builds a rule plus a subgroup and sets the connective to OR; Apply writes a single nested tree", async () => {
    const { queries, user } = await setup();
    await openBuilder(user);

    await user.click(within(panel()).getAllByRole("button", { name: /Add rule/ })[0]!);
    await choose(lastCombobox("Field"), "Name");
    fireEvent.change(within(panel()).getByRole("textbox", { name: "Name Value" }), { target: { value: "Al" } });

    await user.click(within(panel()).getAllByRole("button", { name: /Add group/ })[0]!);
    await choose(lastCombobox("Field"), "Amount");
    await choose(lastCombobox("Condition"), "greater than");
    fireEvent.change(within(panel()).getByRole("spinbutton", { name: "Amount Value" }), { target: { value: "400" } });

    await choose(within(panel()).getByRole("combobox", { name: "Connective" }), "or");
    await user.click(within(panel()).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(lastFilters(queries)).toEqual({
        operator: "OR",
        filters: [
          { field: "name", operator: "contains", value: "Al" },
          { operator: "AND", filters: [{ field: "amount", operator: "gt", value: 400 }] },
        ],
      }),
    );
    expect(screen.queryByRole("region", { name: "Advanced" })).not.toBeInTheDocument();
  });

  it("an incomplete rule blocks Apply and shows the reason", async () => {
    const { user } = await setup();
    await openBuilder(user);
    await user.click(within(panel()).getAllByRole("button", { name: /Add rule/ })[0]!);
    expect(within(panel()).getByText("1 incomplete rule(s)")).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("Cancel discards the draft; the applied filter does not change", async () => {
    const { queries, user } = await setup();
    const before = queries.length;
    await openBuilder(user);
    await user.click(within(panel()).getAllByRole("button", { name: /Add rule/ })[0]!);
    await user.click(within(panel()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Advanced" })).not.toBeInTheDocument();
    expect(queries).toHaveLength(before);
  });

  it("external change: a clean draft refreshes silently; an edited one shows a warning and Reload", async () => {
    const { table, user } = await setup();
    await openBuilder(user);

    const external: FilterGroup = { operator: "AND", filters: [{ field: "name", operator: "eq", value: "Maya" }] };
    act(() => table().setFilters(external));
    expect(await within(panel()).findByRole("textbox", { name: "Name Value" })).toHaveValue("Maya");

    await user.click(within(panel()).getAllByRole("button", { name: /Add rule/ })[0]!);
    act(() => table().setFilters({ operator: "AND", filters: [{ field: "amount", operator: "gt", value: 1 }] }));
    expect(await within(panel()).findByText("Filters were changed elsewhere.")).toBeInTheDocument();
    // The user's edit was not overwritten.
    expect(within(panel()).getByRole("textbox", { name: "Name Value" })).toHaveValue("Maya");

    await user.click(within(panel()).getByRole("button", { name: "Reload" }));
    expect(await within(panel()).findByRole("spinbutton", { name: "Amount Value" })).toHaveValue("1");
    expect(within(panel()).queryByText("Filters were changed elsewhere.")).not.toBeInTheDocument();
  });

  it("Add group is disabled at the depth limit", async () => {
    const { user } = await setup({ mode: "advanced", maxDepth: 1 });
    await openBuilder(user);
    expect(within(panel()).getByRole("button", { name: /Add group/ })).toBeDisabled();
  });

  it("focus moves to the neighbouring row when a row is deleted", async () => {
    const { table, user } = await setup();
    act(() =>
      table().setFilters({
        operator: "AND",
        filters: [
          { field: "name", operator: "contains", value: "A" },
          { field: "amount", operator: "gt", value: 1 },
        ],
      }),
    );
    await openBuilder(user);
    await user.click(within(panel()).getByRole("button", { name: "Delete Name contains A" }));
    const next = within(panel()).getByRole("combobox", { name: "Field" });
    await waitFor(() => expect(next).toHaveFocus());
  });

  it("a nested group is a readable summary chip in the bar; clicking it opens it in the builder", async () => {
    const { table, user } = await setup();
    act(() =>
      table().setFilters({
        operator: "AND",
        filters: [
          { operator: "OR", filters: [{ field: "name", operator: "contains", value: "Al" }, { field: "amount", operator: "gt", value: 400 }] },
        ],
      }),
    );
    const bar = screen.getByRole("group", { name: "Filters" });
    const chip = await within(bar).findByRole("button", { name: "(Name contains Al or Amount greater than 400) — edit" });
    expect(within(bar).queryByText(/External filter/)).not.toBeInTheDocument();

    await user.click(chip);
    expect(await screen.findByRole("region", { name: "Advanced" })).toBeInTheDocument();
    await waitFor(() => expect(within(panel()).getAllByRole("combobox", { name: "Field" })[0]).toHaveFocus());
  });

  it("chip menu: Duplicate copies the rule right after itself, Open in builder opens the panel", async () => {
    const { queries, table, user } = await setup();
    act(() => table().setFilters({ operator: "AND", filters: [{ field: "amount", operator: "gt", value: 400 }] }));
    const bar = screen.getByRole("group", { name: "Filters" });

    await user.click(await within(bar).findByRole("button", { name: "Amount greater than 400 — actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() =>
      expect(lastFilters(queries)).toEqual({
        operator: "AND",
        filters: [
          { field: "amount", operator: "gt", value: 400 },
          { field: "amount", operator: "gt", value: 400 },
        ],
      }),
    );

    await user.click(within(bar).getAllByRole("button", { name: "Amount greater than 400 — actions" })[1]!);
    await user.click(await screen.findByRole("menuitem", { name: "Open in builder" }));
    expect(await screen.findByRole("region", { name: "Advanced" })).toBeInTheDocument();
  });

  it("chips have no action menu in simple mode", async () => {
    const { table } = await setup({ mode: "simple" });
    act(() => table().setFilters({ operator: "AND", filters: [{ field: "amount", operator: "gt", value: 400 }] }));
    const bar = screen.getByRole("group", { name: "Filters" });
    await within(bar).findByRole("button", { name: "Amount greater than 400 — edit" });
    expect(within(bar).queryByRole("button", { name: /actions/ })).not.toBeInTheDocument();
  });
});
