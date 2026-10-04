import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable } from "../DataTable.js";
import { ExportMenu } from "../ExportMenu.js";
import { DataTableRequestError, createLocalDataSource } from "@datatablex/react";
import type { DataSource } from "@datatablex/core";
import { enUS, trTR } from "../locale.js";
import type { DataTableLocale } from "../locale.js";
import type { ReactDataTableColumn } from "@datatablex/react";

interface Row {
  id: number;
  name: string;
  price: number;
}

const rows: Row[] = [
  { id: 1, name: "Ahmet", price: 10 },
  { id: 2, name: "Ayse", price: 20 },
];

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID" },
  { key: "name", title: "Name", type: "text", searchable: true, filterable: true, sortable: true },
  { key: "price", title: "Price", type: "number", filterable: true, sortable: true },
];

function renderTable(locale?: Partial<DataTableLocale>) {
  const dataSource = createLocalDataSource(rows, columns);
  return render(
    <DataTable
      dataSource={dataSource}
      columns={columns}
      rowKey="id"
      searchable
      columnManagement
      selectable
      export={{ formats: ["csv"], scopes: ["currentPage"] }}
      locale={locale}
    />,
  );
}

describe("DataTableProps.locale", () => {
  it("uses the English texts when no locale is given", async () => {
    renderTable();
    await waitFor(() => expect(screen.getByText("Ahmet")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Columns" })).toBeInTheDocument();
    expect(screen.getByText("Export")).toBeInTheDocument();
  });

  it("trTR shows the toolbar, the column menu and the filter bar in Turkish", async () => {
    renderTable(trTR);
    await waitFor(() => expect(screen.getByText("Ahmet")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("Ara...")).toBeInTheDocument();
    expect(screen.getByText("Kolonlar")).toBeInTheDocument();
    expect(screen.getByText("Dışa Aktar")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId("column-header-trigger-price"));
    expect(await screen.findByRole("menu", { name: "Price kolon menüsü" })).toBeInTheDocument();
    expect(screen.getByText("Kaydırmayı Kaldır")).toBeInTheDocument();

    await user.click(screen.getByText("Sırala"));
    expect(await screen.findByText("Sırala Küçükten Büyüğe")).toBeInTheDocument();

    expect(screen.getByRole("group", { name: "Filtreler" })).toBeInTheDocument();
    await user.click(screen.getByText("Filtrele"));
    expect(await screen.findByRole("spinbutton", { name: "Price Değer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uygula" })).toBeInTheDocument();
  });

  it("a partial override changes only the given key", async () => {
    renderTable({ searchPlaceholder: "Search stadium" });
    await waitFor(() => expect(screen.getByText("Ahmet")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("Search stadium")).toBeInTheDocument();
    expect(screen.getByText("Columns")).toBeInTheDocument();
  });

  it("the empty-state text comes from the locale", async () => {
    const dataSource = createLocalDataSource<Row>([], columns);
    render(<DataTable dataSource={dataSource} columns={columns} rowKey="id" locale={{ emptyText: "Nothing here" }} />);
    expect(await screen.findByText("Nothing here")).toBeInTheDocument();
  });

  it("the pagination bar shows the displayed range and the total", async () => {
    renderTable();
    const summary = await screen.findByText("Showing 1–2 of 2");
    // The summary is not inside the pagination list; it is in the sibling element to its left.
    expect(summary.closest(".ant-pagination")).toBeNull();
    expect(summary.parentElement?.lastElementChild).toHaveClass("ant-pagination");
  });

  it("the toolbar is on the same row as the filter bar, on the right", async () => {
    renderTable();
    await waitFor(() => expect(screen.getByText("Ahmet")).toBeInTheDocument());
    const filterGroup = screen.getByRole("group", { name: "Filters" });
    const toolbar = screen.getByRole("button", { name: "Columns" }).closest(".ant-space")!;
    const row = toolbar.parentElement!;
    expect(row.contains(filterGroup)).toBe(true);
    expect(row.lastElementChild).toBe(toolbar);
    expect(toolbar).toHaveStyle({ marginInlineStart: "auto" });
  });

  it("the range summary comes from the locale", async () => {
    renderTable(enUS);
    expect(await screen.findByText("Showing 1–2 of 2")).toBeInTheDocument();
  });

  it("a server error with a code is shown with the locale text, an error without a code with its own message", async () => {
    const failing = (error: Error): DataSource<Row> => ({ fetch: () => Promise.reject(error) });
    const { unmount } = render(
      <DataTable
        dataSource={failing(new DataTableRequestError("No export permission", 403, { message: "No export permission", code: "forbidden" }))}
        columns={columns}
        rowKey="id"
        locale={enUS}
      />,
    );
    await waitFor(() => expect(screen.getByText("You do not have permission for this action.")).toBeInTheDocument());
    expect(screen.queryByText("No export permission")).not.toBeInTheDocument();
    unmount();

    render(<DataTable dataSource={failing(new DataTableRequestError("proxy down", 502, null))} columns={columns} rowKey="id" locale={enUS} />);
    await waitFor(() => expect(screen.getByText("proxy down")).toBeInTheDocument());
  });

  it("a validation error shows the server message as a detail under the generic text; other codes do not", async () => {
    const failing = (error: Error): DataSource<Row> => ({ fetch: () => Promise.reject(error) });
    const serverMessage = "filters.nationalId: a query can contain at most one sensitive filter (found: nationalId)";
    const { unmount } = render(
      <DataTable
        dataSource={failing(new DataTableRequestError(serverMessage, 400, { message: serverMessage, code: "validation" }))}
        columns={columns}
        rowKey="id"
        locale={enUS}
      />,
    );
    await waitFor(() => expect(screen.getByText("The query is invalid. Change the filters, search or sorting.")).toBeInTheDocument());
    expect(screen.getByText(`Details (server): ${serverMessage}`)).toBeInTheDocument();
    unmount();

    render(
      <DataTable
        dataSource={failing(new DataTableRequestError("Field or operator not allowed: ghost", 400, { message: "Field or operator not allowed: ghost", code: "field_not_allowed" }))}
        columns={columns}
        rowKey="id"
      />,
    );
    await waitFor(() => expect(screen.getByText("The query uses a field or condition that is not allowed on this table.")).toBeInTheDocument());
    expect(screen.queryByText(/Details \(server\)/)).not.toBeInTheDocument();
  });

  it("Retry is also hidden for a 4xx error that comes from another copy of the react package", async () => {
    // Version skew: if two copies of `@datatablex/react` are installed, `instanceof` would silently give `false`.
    class OtherCopyRequestError extends Error {
      name = "DataTableRequestError";
      status = 400;
    }
    render(<DataTable dataSource={{ fetch: () => Promise.reject(new OtherCopyRequestError("bad query")) }} columns={columns} rowKey="id" />);
    await waitFor(() => expect(screen.getByText("bad query")).toBeInTheDocument());
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("locale functions that take a column name receive the plain-text title, not the key (exportTitle > string title > key)", async () => {
    const labelled: ReactDataTableColumn<Row>[] = [
      { key: "id", title: "ID" },
      { key: "name", title: <b>Name</b>, exportTitle: "Staff name", type: "text", sortable: true },
      { key: "price", title: <i>Amount</i>, type: "number", sortable: true },
    ];
    const dataSource = createLocalDataSource(rows, labelled);
    render(
      <DataTable
        dataSource={dataSource}
        columns={labelled}
        rowKey="id"
        columnManagement
        locale={{ resizeHandle: (label) => `resize:${label}`, moveUp: (label) => `up:${label}`, columnMenu: (label) => `menu:${label}` }}
      />,
    );
    await screen.findByText("Ahmet");
    expect(screen.getByLabelText("resize:Staff name")).toBeInTheDocument();
    // A column whose title is a ReactNode and that has no exportTitle falls back to the key.
    expect(screen.getByLabelText("resize:price")).toBeInTheDocument();
    expect(screen.getByLabelText("resize:ID")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Columns/ }));
    expect(await screen.findByLabelText("up:Staff name")).toBeInTheDocument();
  });

  it("trTR and enUS have the same set of keys", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(trTR).sort());
  });

  it("a part rendered outside the provider falls back to the default English", () => {
    render(
      <ExportMenu definition={{ formats: ["csv"], scopes: ["currentPage"] }} selectedCount={0} isExporting={false} progress={null} onExport={() => {}} />,
    );
    expect(screen.getByText("Export")).toBeInTheDocument();
  });
});
