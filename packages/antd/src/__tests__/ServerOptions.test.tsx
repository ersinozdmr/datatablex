import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import type { DataSource, DataTableEndpointMeta, DataTableFieldOption, DataTableQuery } from "@datatablex/core";
import { useDataTable } from "@datatablex/react";
import type { ReactDataTableColumn, TableInstance } from "@datatablex/react";
import { DataTable } from "../DataTable.js";

/** Enum options that come from the server: lazy loading, chip labels, failure. */
interface Row {
  id: number;
  status: string;
}

const columns: ReactDataTableColumn<Row>[] = [
  // A second filterable column: the filter bar stays in place when "Status" is gone.
  { key: "id", title: "ID", type: "number", filterable: true, filterOperators: ["eq"] },
  { key: "status", title: "Status", type: "enum", filterable: true },
];

const meta: DataTableEndpointMeta = {
  version: 1,
  protocol: { version: 1, supported: [1] },
  primaryKey: "id",
  limits: { maxPageSize: 500, maxFilterDepth: 3, maxFilterCount: 50, maxInValues: 500, maxSearchLength: 200, maxSortCount: 3, maxOffset: null },
  fields: {
    id: { type: "number", filterOperators: ["eq", "in"], sortable: false, searchable: false },
    status: { type: "enum", filterOperators: ["in", "notIn"], sortable: false, searchable: false, hasOptions: true },
  },
};

const OPTIONS: DataTableFieldOption[] = [
  { label: "Open", value: "open" },
  { label: "Closed", value: "closed" },
];

function setup(getOptions: () => Promise<DataTableFieldOption[]>) {
  const queries: DataTableQuery[] = [];
  const source = {
    fetch: async (query: DataTableQuery) => {
      queries.push(structuredClone(query));
      return { data: [{ id: 1, status: "open" }], pagination: { page: 1, pageSize: query.pagination.pageSize, total: 1 } };
    },
    getMeta: () => Promise.resolve(meta),
    getOptions: vi.fn(getOptions),
  } satisfies DataSource<Row>;
  let table: TableInstance<Row> | undefined;
  function Harness() {
    const instance = useDataTable({ dataSource: source, columns, rowKey: "id", awaitMeta: true });
    table = instance;
    return <DataTable table={instance} />;
  }
  render(<Harness />);
  return { source, queries, table: () => table!, user: userEvent.setup() };
}

async function choose(user: UserEvent, label: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: label }));
  const found = await screen.findAllByTitle(option);
  await user.click(found[found.length - 1]!);
}

const bar = () => screen.findByRole("group", { name: "Filters" });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<DataTable> — enum options from the server", () => {
  it("fetches the options once when the field is chosen; shows a loading state, then applies the rule", async () => {
    let release = (_options: DataTableFieldOption[]) => {};
    const { source, queries, user } = setup(() => new Promise((resolve) => (release = resolve)));
    await user.click(within(await bar()).getByRole("button", { name: /Add filter/ }));
    expect(source.getOptions).not.toHaveBeenCalled();

    await choose(user, "Field", "Status");
    expect(await screen.findByText("Loading options…")).toBeInTheDocument();
    expect(source.getOptions).toHaveBeenCalledTimes(1);

    release(OPTIONS);
    await user.click(await screen.findByRole("checkbox", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(queries[queries.length - 1]!.filters).toEqual({ operator: "AND", filters: [{ field: "status", operator: "in", value: ["open"] }] }));
    const chip = await within(await bar()).findByRole("button", { name: /^Status .* Open — edit$/ });

    // Reopening makes no request.
    await user.click(chip);
    expect(await screen.findByRole("checkbox", { name: "Closed" })).toBeInTheDocument();
    expect(source.getOptions).toHaveBeenCalledTimes(1);
  });

  it("the chip of an active rule shows the label without opening the editor", async () => {
    const { source, table } = setup(() => Promise.resolve(OPTIONS));
    await bar();
    table().setFilters({ operator: "AND", filters: [{ field: "status", operator: "in", value: ["closed"] }] });
    expect(await within(await bar()).findByRole("button", { name: /^Status .* Closed — edit$/ })).toBeInTheDocument();
    expect(source.getOptions).toHaveBeenCalledTimes(1);
  });

  it("when the options cannot be loaded, the editor says so and the table keeps working", async () => {
    const { user } = setup(() => Promise.reject(new Error("500")));
    await user.click(within(await bar()).getByRole("button", { name: /Add filter/ }));
    await choose(user, "Field", "Status");
    expect(await screen.findByText("The options for this field could not be loaded; the filter is unavailable.")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("gives no 'missing options' warning for an enum column without options while the meta is awaited", async () => {
    setup(() => Promise.resolve(OPTIONS));
    await bar();
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).not.toContain("An automatic filter could not be generated");
  });
});
