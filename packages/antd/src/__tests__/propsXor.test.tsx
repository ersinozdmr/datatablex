import { describe, expect, it } from "vitest";
import { createLocalDataSource } from "@datatablex/react";
import type { ReactDataTableColumn, TableInstance } from "@datatablex/react";
import type { DataTableProps } from "../types.js";

interface Row {
  id: number;
  name: string;
}

const columns: ReactDataTableColumn<Row>[] = [{ key: "id", title: "ID" }, { key: "name", title: "Name" }];
const dataSource = createLocalDataSource<Row>([], columns);
const table = {} as TableInstance<Row>;

/**
 * Compile-time contract: the controlled (`table`) form and the options form
 * cannot be given together. `pnpm typecheck` fails if any of the
 * `@ts-expect-error` lines in this file does not produce an error.
 */
describe("DataTableProps — the two ownership models cannot be combined", () => {
  it("each form is valid on its own", () => {
    const controlled: DataTableProps<Row> = { table, searchable: true };
    const options: DataTableProps<Row> = { dataSource, columns, rowKey: "id", searchable: true };
    expect([controlled, options]).toHaveLength(2);
  });

  it("giving table together with the hook options is a compile error", () => {
    // @ts-expect-error with `table`, `dataSource`/`columns`/`rowKey` would be silently ignored
    const both: DataTableProps<Row> = { table, dataSource, columns, rowKey: "id" };
    // @ts-expect-error `lockedFilters` looks like an authorization but would not be applied in the `table` form
    const locked: DataTableProps<Row> = { table, lockedFilters: null };
    expect([both, locked]).toHaveLength(2);
  });
});
