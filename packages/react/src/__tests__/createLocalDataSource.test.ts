import { describe, expect, it } from "vitest";
import type { DataTableQuery, QueryableColumn } from "@datatablex/core";
import { createLocalDataSource } from "../query/createLocalDataSource.js";

interface Row {
  id: number;
  name: string;
}

const rows: Row[] = [
  { id: 1, name: "Ahmet" },
  { id: 2, name: "Mehmet" },
  { id: 3, name: "Ayse" },
];

const columns: QueryableColumn<Row>[] = [
  { key: "id", type: "number" },
  { key: "name", type: "text", searchable: true },
];

function baseQuery(overrides: Partial<DataTableQuery> = {}): DataTableQuery {
  return { pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null, ...overrides };
}

describe("createLocalDataSource", () => {
  it("wraps queryInMemory behind the DataSource interface", async () => {
    const source = createLocalDataSource(rows, columns);
    const result = await source.fetch(baseQuery());
    expect(result.data).toHaveLength(3);
    expect(result.pagination).toEqual({ page: 1, pageSize: 20, total: 3 });
  });

  it("respects search scoped to searchable columns", async () => {
    const source = createLocalDataSource(rows, columns);
    const result = await source.fetch(baseQuery({ search: "ayse" }));
    expect(result.data.map((r) => r.id)).toEqual([3]);
  });
});
