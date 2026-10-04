import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { DataSource } from "@datatablex/core";
import { createLocalDataSource } from "@datatablex/react";
import type { ReactDataTableColumn, UrlStateAdapter } from "@datatablex/react";
import { DataTable } from "../DataTable.js";

interface Row {
  id: number;
  name: string;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID", type: "number" },
  { key: "name", title: "Name", type: "text", searchable: true, sortable: true },
];

const source: DataSource<Row> = createLocalDataSource(
  Array.from({ length: 45 }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}` })),
  columns,
);

function memoryAdapter(initial: string): UrlStateAdapter {
  let params = new URLSearchParams(initial);
  return { get: () => new URLSearchParams(params), set: (next) => (params = new URLSearchParams(next)), subscribe: () => () => {} };
}

describe("<DataTable> + syncWithUrl", () => {
  it("the <DataTable> search box shows the term from the URL", async () => {
    const adapter = memoryAdapter("search=Row 4");
    render(<DataTable dataSource={source} columns={columns} rowKey="id" searchable syncWithUrl={adapter} />);
    await waitFor(() => expect(screen.getByPlaceholderText("Search...")).toHaveValue("Row 4"));
  });
});
