import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DataSource, DataTableQuery } from "@datatablex/core";
import { createLocalDataSource, useDataTable } from "@datatablex/react";
import type { ReactDataTableColumn, TableInstance } from "@datatablex/react";
import { DataTable } from "../DataTable.js";

/** Column roles: `key` is the identity, `field` the backend field, `accessor` the displayed value. */
interface Row {
  id: number;
  code: string;
  codeMasked: string;
  first: string;
  last: string;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "codeColumn", field: "code", accessor: "codeMasked", title: "Code", type: "text", sortable: true, filterable: true, filterOperators: ["eq"] },
  { key: "fullName", field: null, accessor: (row) => `${row.first} ${row.last}`, title: "Full Name" },
];

const rows: Row[] = [
  { id: 1, code: "222", codeMasked: "**2", first: "Ada", last: "Smith" },
  { id: 2, code: "111", codeMasked: "**1", first: "Can", last: "Demir" },
];

function recording(): { source: DataSource<Row>; queries: DataTableQuery[] } {
  const local = createLocalDataSource(rows, columns);
  const queries: DataTableQuery[] = [];
  return { queries, source: { fetch: (query, options) => (queries.push(structuredClone(query)), local.fetch(query, options)) } };
}

afterEach(() => vi.restoreAllMocks());

describe("<DataTable> — column roles", () => {
  it("the cell shows the accessor value: a masked field and a computed column", async () => {
    const { source } = recording();
    render(<DataTable dataSource={source} columns={columns} rowKey="id" />);
    expect(await screen.findByText("**2")).toBeInTheDocument();
    expect(screen.getByText("Can Demir")).toBeInTheDocument();
    expect(screen.queryByText("222")).not.toBeInTheDocument();
  });

  it("sorting from the header menu sends the backend field; a computed column has no sorting", async () => {
    const { source, queries } = recording();
    render(<DataTable dataSource={source} columns={columns} rowKey="id" />);
    await screen.findByText("**2");
    const user = userEvent.setup();

    await user.click(screen.getByTestId("column-header-trigger-codeColumn"));
    await user.click(await screen.findByRole("menuitem", { name: /Sort/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /A → Z/ }));
    await waitFor(() => expect(queries[queries.length - 1]!.sorting).toEqual([{ field: "code", direction: "asc" }]));
    await waitFor(() => expect(screen.getAllByRole("row")[1]).toHaveTextContent("**1"));

    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("column-header-trigger-fullName"));
    expect(screen.queryByRole("menuitem", { name: /Sort/ })).not.toBeInTheDocument();
  });

  it("the filter bar binds a rule written with field to the column and shows it as a chip", async () => {
    const { source } = recording();
    let table: TableInstance<Row> | undefined;
    function Harness() {
      table = useDataTable({ dataSource: source, columns, rowKey: "id" });
      return <DataTable table={table} filterBar />;
    }
    render(<Harness />);
    await screen.findByText("**2");
    table!.setFilters({ operator: "AND", filters: [{ field: "code", operator: "eq", value: "111" }] });
    const bar = await screen.findByRole("group", { name: "Filters" });
    expect(await within(bar).findByRole("button", { name: "Code equals 111 — edit" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
  });
});
