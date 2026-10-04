import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { DataSource, DataTableQuery, DataTableResult } from "@datatablex/core";
import { useDataTable } from "../state/useDataTable.js";
import type { ReactDataTableColumn, TableInstance } from "../types.js";

/**
 * Sequence-number race: a stale response must not overwrite a newer state.
 *
 * `act()` is NOT used: `act` flushes effects synchronously and closes the window where the race happens.
 * The window: a non-React event (a timer, `popstate`) changes the query; the render and the effect
 * cleanup run in the next task, while the response of the old request comes back WITHIN ONE MICROTASK.
 */
interface Row {
  id: number;
}
const columns: ReactDataTableColumn<Row>[] = [{ key: "id", title: "ID" }];

interface PendingFetch {
  query: DataTableQuery;
  resolve: () => void;
}

function manualSource() {
  const calls: PendingFetch[] = [];
  const dataSource: DataSource<Row> = {
    fetch: (query) =>
      new Promise<DataTableResult<Row>>((resolve) => {
        calls.push({
          query,
          resolve: () =>
            resolve({ data: [{ id: query.pagination.page }], pagination: { page: query.pagination.page, pageSize: query.pagination.pageSize, total: 100 } }),
        });
      }),
  };
  return { dataSource, calls };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(condition: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`timeout: ${label}`);
}

let root: Root;
const previousActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  root.unmount();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnv;
});

describe("useDataTable — a stale response that returns after the query changed but before the effect ran", () => {
  it("does not overwrite page 1 of the new search with the page of the old query", async () => {
    const { dataSource, calls } = manualSource();
    let table!: TableInstance<Row>;
    function Probe() {
      table = useDataTable({ dataSource, columns, rowKey: "id" });
      return null;
    }
    root.render(<Probe />);

    await until(() => calls.length === 1, "first request");
    calls[0]!.resolve();
    await until(() => !table.loading, "initial load");

    table.pagination.onChange(5, 20);
    await until(() => calls.length === 2 && calls[1]!.query.pagination.page === 5, "page 5 request");
    const page5 = calls[1]!;

    // In a single task: the query changes and the old request resolves. The render has not run yet.
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        table.setSearch("x");
        page5.resolve();
        resolve();
      }, 0);
    });
    // After the race window, wait for the system to settle: the request of the new search (if any) resolves.
    for (let i = 0; i < 20; i++) {
      await tick();
      for (const pending of calls) pending.resolve();
    }

    expect(table.search).toBe("x");
    expect(table.pagination.current).toBe(1);
    // No request may send the "x" search together with page 5.
    expect(calls.filter((call) => call.query.search === "x").every((call) => call.query.pagination.page === 1)).toBe(true);
    expect(table.data).toEqual([{ id: 1 }]);
  });
});
