import { describe, expect, it } from "vitest";
import { createInitialState, dataTableReducer } from "../state/reducer.js";
import type { DataTableAction, DataTableState } from "../state/reducer.js";

interface Row {
  id: number;
}

const initial = (): DataTableState<Row> => createInitialState<Row>();

function apply(state: DataTableState<Row>, ...actions: DataTableAction<Row>[]) {
  return actions.reduce(dataTableReducer<Row>, state);
}

const success = (
  overrides: Partial<Extract<DataTableAction<Row>, { type: "FETCH_SUCCESS" }>> = {},
): DataTableAction<Row> => ({
  type: "FETCH_SUCCESS",
  data: [{ id: 1 }],
  total: 45,
  page: 1,
  pageSize: 20,
  ...overrides,
});

describe("dataTableReducer — page reset rule", () => {
  it("setSorting/setFilters/setSearch return the page to 1", () => {
    const onPage3 = apply(initial(), { type: "SET_PAGE", page: 3, pageSize: 20 });
    expect(onPage3.page).toBe(3);

    expect(
      apply(onPage3, { type: "SET_SORTING", sorting: [{ field: "id", direction: "asc" }] }).page,
    ).toBe(1);
    expect(apply(onPage3, { type: "SET_FILTERS", filters: null }).page).toBe(1);
    expect(apply(onPage3, { type: "SET_SEARCH", search: "x" }).page).toBe(1);
  });

  it("plain page turning keeps the page, a pageSize change returns it to 1", () => {
    const onPage3 = apply(initial(), { type: "SET_PAGE", page: 3, pageSize: 20 });
    expect(apply(onPage3, { type: "SET_PAGE", page: 4, pageSize: 20 }).page).toBe(4);

    const resized = apply(onPage3, { type: "SET_PAGE", page: 4, pageSize: 50 });
    expect(resized.page).toBe(1);
    expect(resized.pageSize).toBe(50);
  });

  it("CORRECT_PAGE, unlike SET_PAGE, does NOT pull the page to 1", () => {
    const onPage999 = apply(initial(), { type: "SET_PAGE", page: 999, pageSize: 20 });
    expect(apply(onPage999, { type: "CORRECT_PAGE", page: 3 }).page).toBe(3);
  });

  it("reset() also clears the selection and resets reloadToken", () => {
    const dirty = apply(
      initial(),
      { type: "SET_PAGE", page: 3, pageSize: 20 },
      { type: "SET_SEARCH", search: "x" },
      { type: "SET_SELECTED_ROW_KEYS", keys: [1, 2] },
      { type: "RELOAD" },
    );
    expect(dirty.selectedRowKeys).toEqual([1, 2]);
    expect(dirty.reloadToken).toBe(1);

    const cleared = apply(dirty, { type: "RESET" });
    expect(cleared.selectedRowKeys).toEqual([]);
    expect(cleared.search).toBe("");
    expect(cleared.page).toBe(1);
    expect(cleared.reloadToken).toBe(0);
  });

  it("reset() keeps the data currently on screen and loading/error", () => {
    const loaded = apply(initial(), success());
    const cleared = apply(loaded, { type: "RESET" });
    expect(cleared.data).toEqual([{ id: 1 }]);
    expect(cleared.total).toBe(45);
    expect(cleared.loading).toBe(false);
  });
});

describe("dataTableReducer — FETCH_SUCCESS total contract", () => {
  it("the LAST KNOWN total is kept when total: null arrives", () => {
    const loaded = apply(initial(), success({ total: 45 }));
    expect(loaded.total).toBe(45);

    // skipCount response: new page data arrives but no count.
    const skipped = apply(loaded, success({ total: null, page: 2, data: [{ id: 2 }] }));
    expect(skipped.total).toBe(45); // not reset — so that pagination is not hidden
    expect(skipped.page).toBe(2);
    expect(skipped.data).toEqual([{ id: 2 }]);
  });

  it("when total: 0 arrives it does NOT fall back to the old total (0 is a valid count)", () => {
    const loaded = apply(initial(), success({ total: 45 }));
    expect(apply(loaded, success({ total: 0, data: [] })).total).toBe(0);
  });

  it("the effective page/pageSize is read from the response (maxPageSize clamping)", () => {
    const loaded = apply(
      initial(),
      { type: "SET_PAGE", page: 1, pageSize: 5000 },
      success({ page: 1, pageSize: 100 }),
    );
    expect(loaded.pageSize).toBe(100);
  });

  it("FETCH_SUCCESS clears the previous error", () => {
    const failed = apply(initial(), { type: "FETCH_ERROR", error: new Error("boom") });
    expect(failed.error?.message).toBe("boom");
    expect(failed.loading).toBe(false);

    expect(apply(failed, success()).error).toBeNull();
  });
});

describe("NORMALIZE_QUERY", () => {
  const limits = { maxPageSize: 10, maxSearchLength: 3, sortableFields: new Set(["name"]) };

  it("clamps the page size, drops a non-sortable field, truncates the search; the page is kept", () => {
    const state = { ...initial(), page: 4, pageSize: 50, sorting: [{ field: "age", direction: "desc" as const }, { field: "name", direction: "asc" as const }], search: "Springfield" };
    const next = apply(state, { type: "NORMALIZE_QUERY", limits });
    expect(next).toMatchObject({ page: 4, pageSize: 10, sorting: [{ field: "name", direction: "asc" }], search: "Spr", searchVersion: state.searchVersion + 1 });
  });

  it("returns a state that already fits the limits as the SAME object", () => {
    const state = { ...initial(), pageSize: 10, sorting: [{ field: "name", direction: "asc" as const }], search: "Sp" };
    expect(apply(state, { type: "NORMALIZE_QUERY", limits })).toBe(state);
  });
});
