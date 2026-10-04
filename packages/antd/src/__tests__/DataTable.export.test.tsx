import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTableRequestError, createLocalDataSource } from "@datatablex/react";
import type { ReactDataTableColumn } from "@datatablex/react";
import type { DataSource, DataTableEndpointMeta } from "@datatablex/core";
import { excelExporter } from "@datatablex/react/excel";
import { DataTable } from "../DataTable.js";

interface Row {
  id: number;
  name: string;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID" },
  { key: "name", title: "Name" },
];
const dataSource = createLocalDataSource<Row>([{ id: 1, name: "Ada" }], columns);
const exportDefinition = { formats: ["csv", "excel", "pdf"] as Array<"csv" | "excel" | "pdf">, scopes: ["allFiltered"] as Array<"allFiltered"> };

afterEach(() => vi.restoreAllMocks());

describe("<DataTable export> — adapter registration", () => {
  it("formats without a registered adapter are not shown in the menu and are warned about once in development mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<DataTable dataSource={dataSource} columns={columns} rowKey="id" export={exportDefinition} />);
    await waitFor(() => expect(screen.getByText("Ada")).toBeInTheDocument());

    await userEvent.setup().click(screen.getByRole("button", { name: /Export/ }));
    expect(await screen.findByRole("button", { name: /CSV/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Excel/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /PDF/ })).not.toBeInTheDocument();
    expect(warn.mock.calls.filter(([message]) => String(message).includes("no adapter is registered for them and the server does not produce them"))).toHaveLength(1);
    expect(String(warn.mock.calls.find(([m]) => String(m).includes("no adapter is registered"))![0])).toContain("excel, pdf");
  });

  it("a format registered through exporters is shown in the menu", async () => {
    render(<DataTable dataSource={dataSource} columns={columns} rowKey="id" exporters={[excelExporter]} export={exportDefinition} />);
    await waitFor(() => expect(screen.getByText("Ada")).toBeInTheDocument());

    await userEvent.setup().click(screen.getByRole("button", { name: /Export/ }));
    expect(await screen.findByRole("button", { name: /Excel/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /PDF/ })).not.toBeInTheDocument();
  });
});

describe("<DataTable export> — row limit", () => {
  it("a message that suggests CSV is shown when the Excel limit is exceeded", async () => {
    const many = createLocalDataSource<Row>([{ id: 1, name: "Ada" }, { id: 2, name: "Bora" }, { id: 3, name: "Can" }], columns);
    render(<DataTable dataSource={many} columns={columns} rowKey="id" exporters={[excelExporter]} maxClientExportRows={2} export={exportDefinition} />);
    await waitFor(() => expect(screen.getByText("Ada")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByRole("button", { name: /Excel/ }));
    expect(await screen.findByText("This format supports at most 2 rows. Choose CSV or narrow the filters.")).toBeInTheDocument();
  });
});

describe("<DataTable export> — server export", () => {
  const meta: DataTableEndpointMeta = {
    version: 1,
    protocol: { version: 1, supported: [1] },
    primaryKey: "id",
    limits: { maxPageSize: 500, maxFilterDepth: 3, maxFilterCount: 50, maxInValues: 500, maxSearchLength: 200, maxSortCount: 3, maxOffset: null },
    fields: { id: { type: "number", filterOperators: ["in"], sortable: false, searchable: false }, name: { type: "text", filterOperators: [], sortable: false, searchable: false } },
    export: { formats: { csv: 100, excel: 100, pdf: 100 }, fields: ["id", "name"] },
  };

  function serverSource(requestExport: NonNullable<DataSource<Row>["requestExport"]>): DataSource<Row> {
    const local = createLocalDataSource<Row>([{ id: 1, name: "Ada" }], columns);
    return { fetch: (query, options) => local.fetch(query, options), getMeta: async () => meta, requestExport };
  }

  it("the server's formats are shown in the menu without adapters; the download starts when the ticket arrives and a notice is shown", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const requestExport = vi.fn(async () => ({ ticket: "t", total: 1, filename: "x.pdf", expiresAt: "2026-09-28T00:00:00.000Z", downloadUrl: "/q/export/download?ticket=t" }));
    render(<DataTable dataSource={serverSource(requestExport)} columns={columns} rowKey="id" export={exportDefinition} />);
    await waitFor(() => expect(screen.getByText("Ada")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByRole("button", { name: /PDF/ }));
    expect(await screen.findByText("Download started. You can find the file in your browser's downloads.")).toBeInTheDocument();
    expect(requestExport).toHaveBeenCalledWith(expect.objectContaining({ format: "pdf", scope: "allFiltered", title: "Export" }), expect.anything());
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("when rowKey differs from the backend primaryKey the \"Selected rows\" scope is disabled and the reason is shown", async () => {
    const requestExport = vi.fn(async () => ({ ticket: "t", total: 1, filename: "x.csv", expiresAt: "2026-09-28T00:00:00.000Z", downloadUrl: "/d?ticket=t" }));
    render(
      <DataTable
        dataSource={serverSource(requestExport)}
        columns={columns}
        rowKey="name"
        selectable
        export={{ formats: ["csv"], scopes: ["allFiltered", "selected"] }}
      />,
    );
    await waitFor(() => expect(screen.getByText("Ada")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("checkbox")[1]!);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    const selected = await screen.findByRole("radio", { name: /Selected rows/ });
    expect(selected).toBeDisabled();
    expect(screen.getByText(/the row key does not match the server primary key/)).toBeInTheDocument();
    expect(requestExport).not.toHaveBeenCalled();
  });

  it("a warning is shown when the server is busy (429)", async () => {
    const requestExport = vi.fn(async () => {
      throw new DataTableRequestError("busy", 429, { error: "Too Many Exports", maxConcurrent: 4 });
    });
    render(<DataTable dataSource={serverSource(requestExport)} columns={columns} rowKey="id" export={exportDefinition} />);
    await waitFor(() => expect(screen.getByText("Ada")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByRole("button", { name: /Excel/ }));
    expect(await screen.findByText("The server is busy with other exports. Try again in a moment.")).toBeInTheDocument();
  });
});
