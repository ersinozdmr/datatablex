import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  createdAt: string;
  nationalId: string;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "name", title: "Name", type: "text", filterable: true, filterOperators: ["contains", "notContains", "eq", "isNull"] },
  { key: "amount", title: "Amount", type: "number", filterable: true },
  { key: "createdAt", title: "Date", type: "datetime", timezone: "Europe/Istanbul", filterable: true },
  { key: "nationalId", title: "National ID", type: "text", filterable: true, filterOperators: ["eq"] },
];

const rows: Row[] = [
  { id: 1, name: "Alice", amount: 100, createdAt: "2026-09-01T10:00:00.000Z", nationalId: "1" },
  { id: 2, name: "Bernard", amount: 250, createdAt: "2026-09-05T10:00:00.000Z", nationalId: "2" },
  { id: 3, name: "Maya", amount: 500, createdAt: "2026-09-09T10:00:00.000Z", nationalId: "3" },
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

const lastFilters = (queries: DataTableQuery[]) => queries[queries.length - 1]!.filters;

/** A wrapper that exposes the hook so tests can also call `table.setFilters` from outside the table. */
function Harness({ source, filterBar = true, onTable }: { source: DataSource<Row>; filterBar?: boolean | FilterBarOptions; onTable?: (t: TableInstance<Row>) => void }) {
  const table = useDataTable({ dataSource: source, columns, rowKey: "id" });
  onTable?.(table);
  return <DataTable table={table} filterBar={filterBar} />;
}

async function renderBar(props: { filterBar?: boolean | FilterBarOptions } = {}) {
  const { source, queries } = recordingSource();
  let table: TableInstance<Row> | undefined;
  render(<Harness source={source} filterBar={props.filterBar} onTable={(t) => (table = t)} />);
  await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
  return { queries, table: () => table!, user: userEvent.setup() };
}

async function choose(user: UserEvent, label: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: label }));
  const options = await screen.findAllByTitle(option);
  await user.click(options[options.length - 1]!);
}

const bar = () => screen.getByRole("group", { name: "Filters" });

describe("<DataTable filterBar>", () => {
  it("+ Add filter: field -> condition -> value -> Apply produces a single rule leaf", async () => {
    const { queries, user } = await renderBar();
    await user.click(within(bar()).getByRole("button", { name: /Add filter/ }));
    await choose(user, "Field", "Name");
    await choose(user, "Condition", "does not contain");
    expect(screen.getByText("(empty values excluded)")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Name Value" }), "Al");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(lastFilters(queries)).toEqual({ operator: "AND", filters: [{ field: "name", operator: "notContains", value: "Al" }] }),
    );
    expect(within(bar()).getByRole("button", { name: "Name does not contain Al — edit" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument());
  });

  it("editing from a chip changes the existing rule in place", async () => {
    const { queries, table, user } = await renderBar();
    table().setFilters({ operator: "AND", filters: [{ field: "amount", operator: "gte", value: 200 }] });
    const chip = await within(bar()).findByRole("button", { name: "Amount greater than or equal 200 — edit" });

    await user.click(chip);
    const input = await screen.findByRole("spinbutton", { name: "Amount Value" });
    await user.clear(input);
    await user.type(input, "300");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(lastFilters(queries)).toEqual({ operator: "AND", filters: [{ field: "amount", operator: "gte", value: 300 }] }),
    );
  });

  it("keeps a node the bar cannot represent as a read-only summary; removing a rule does not touch it", async () => {
    const { queries, table, user } = await renderBar();
    const external: FilterGroup = {
      operator: "OR",
      filters: [
        { field: "amount", operator: "lt", value: 150 },
        { field: "amount", operator: "gt", value: 400 },
      ],
    };
    table().setFilters({ operator: "AND", filters: [external, { field: "name", operator: "contains", value: "e" }] });
    expect(await within(bar()).findByText("External filter (2 rules)")).toBeInTheDocument();

    await user.click(within(bar()).getByRole("button", { name: "Remove filter Name contains e" }));
    await waitFor(() => expect(lastFilters(queries)).toEqual({ operator: "AND", filters: [external] }));
    expect(within(bar()).getByText("External filter (2 rules)")).toBeInTheDocument();
  });

  it("Clear all removes the filters", async () => {
    const { queries, table, user } = await renderBar();
    table().setFilters({ operator: "AND", filters: [{ field: "name", operator: "contains", value: "e" }] });
    await user.click(await within(bar()).findByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(lastFilters(queries)).toBeNull());
    expect(within(bar()).queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it("a datetime on-day rule compiles to a half-open gte+lt group in the column timezone and reads as a single chip", async () => {
    const { queries, user } = await renderBar();
    await user.click(within(bar()).getByRole("button", { name: /Add filter/ }));
    await choose(user, "Field", "Date");
    await choose(user, "Condition", "on");
    fireEvent.change(screen.getByLabelText("Date Value"), { target: { value: "2026-09-05" } });
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(lastFilters(queries)).toEqual({
        operator: "AND",
        filters: [
          {
            operator: "AND",
            filters: [
              { field: "createdAt", operator: "gte", value: "2026-09-04T21:00:00.000Z" },
              { field: "createdAt", operator: "lt", value: "2026-09-05T21:00:00.000Z" },
            ],
          },
        ],
      }),
    );
    expect(within(bar()).getByRole("button", { name: "Date on 2026-09-05 — edit" })).toBeInTheDocument();
  });

  it("the depth limit also applies in simple mode: with maxDepth 1 a datetime on-day rule cannot be applied", async () => {
    const { queries, user } = await renderBar({ filterBar: { maxDepth: 1 } });
    const before = queries.length;
    await user.click(within(bar()).getByRole("button", { name: /Add filter/ }));
    await choose(user, "Field", "Date");
    await choose(user, "Condition", "on");
    fireEvent.change(screen.getByLabelText("Date Value"), { target: { value: "2026-09-05" } });

    expect(await screen.findByText(/Groups can be nested at most 1 levels/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(queries).toHaveLength(before);

    // A flat rule can be applied at the same limit.
    await choose(user, "Condition", "on or after");
    fireEvent.change(screen.getByLabelText("Date Value"), { target: { value: "2026-09-05" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled());
  });

  it("a field that only allows eq offers only the allowed conditions", async () => {
    const { user } = await renderBar();
    await user.click(within(bar()).getByRole("button", { name: /Add filter/ }));
    await choose(user, "Field", "National ID");
    await user.click(screen.getByRole("combobox", { name: "Condition" }));
    expect((await screen.findAllByTitle("equals")).length).toBeGreaterThan(0);
    expect(screen.queryByTitle("contains")).not.toBeInTheDocument();
  });

  it("+ Add filter is disabled when the rule limit is reached", async () => {
    const { table } = await renderBar({ filterBar: { maxRules: 1 } });
    table().setFilters({ operator: "AND", filters: [{ field: "name", operator: "contains", value: "e" }] });
    await waitFor(() => expect(within(bar()).getByRole("button", { name: /Add filter/ })).toBeDisabled());
  });

  it("the header menu Filter item opens no submenu; it opens a new rule editor with the field preselected and focuses the value input", async () => {
    const { queries, user } = await renderBar();
    await user.click(screen.getByTestId("column-header-trigger-name"));
    const filterRow = await screen.findByRole("menuitem", { name: /Filter/ });
    expect(filterRow).not.toHaveAttribute("aria-haspopup");
    await user.click(filterRow);

    const input = await screen.findByRole("textbox", { name: "Name Value" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Filter" })).not.toBeInTheDocument();
    await user.type(input, "Ma");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(lastFilters(queries)).toEqual({ operator: "AND", filters: [{ field: "name", operator: "contains", value: "Ma" }] }),
    );
  });

  it("when the field has a single rule, the shortcut opens that chip for editing", async () => {
    const { table, user } = await renderBar();
    table().setFilters({ operator: "AND", filters: [{ field: "amount", operator: "gte", value: 200 }] });
    await within(bar()).findByRole("button", { name: "Amount greater than or equal 200 — edit" });

    await user.click(screen.getByTestId("column-header-trigger-amount"));
    await user.click(await screen.findByRole("menuitem", { name: /Filter/ }));
    const input = await screen.findByRole("spinbutton", { name: "Amount Value" });
    expect(input).toHaveValue("200");
  });
});
