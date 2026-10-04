import type { Key } from "react";
import type { FilterGroup, Sort } from "@datatablex/core";

/** The page size the table starts with. */
export const DEFAULT_PAGE_SIZE = 20;

/** The complete state of the table, as held by `dataTableReducer`. */
export interface DataTableState<T> {
  /** The current page, 1-based. */
  page: number;
  /** The number of rows per page. */
  pageSize: number;
  /** The active sorting. */
  sorting: Sort[];
  /** The user's filter tree. */
  filters: FilterGroup | null;
  /** The current search term. */
  search: string;
  /** The keys of the selected rows. */
  selectedRowKeys: Key[];
  /** The rows of the current page. */
  data: T[];
  /** The total number of rows. */
  total: number;
  /** Whether a query is in flight. */
  loading: boolean;
  /** The error of the last query, or `null`. */
  error: Error | null;
  /** `reload()` triggers the fetch effect through this value, so the data is fetched again while the page is kept. */
  reloadToken: number;
  /**
   * Increases on every search CHANGE REQUEST, even when `search` ITSELF does
   * not change (for example `reset()` while it is already empty). If the
   * debounce sync effect of `DataTable` in `@datatablex/antd` watched only the
   * VALUE of `search`, a `reset()` that leaves the value the same would
   * trigger nothing and could not undo a keystroke that is waiting inside the
   * debounce window. This counter provides a value-independent "something
   * happened" signal.
   */
  searchVersion: number;
}

/** Creates the state the table starts with: page 1, the default page size, no query parameters, and `loading` set to `true`. */
export function createInitialState<T>(): DataTableState<T> {
  return {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sorting: [],
    filters: null,
    search: "",
    selectedRowKeys: [],
    data: [],
    total: 0,
    loading: true,
    error: null,
    reloadToken: 0,
    searchVersion: 0,
  };
}

/** The client and endpoint limits that a query has to respect (see `NORMALIZE_QUERY`). */
export interface QueryLimits {
  /** The largest page size allowed; no cap when it is not given. */
  maxPageSize?: number;
  /** The longest search term allowed. */
  maxSearchLength: number;
  /** The fields that can be sorted; sorting on any other field is dropped. */
  sortableFields: ReadonlySet<string>;
}

/** The actions `dataTableReducer` accepts. */
export type DataTableAction<T> =
  | { type: "SET_SORTING"; sorting: Sort[] }
  | { type: "SET_FILTERS"; filters: FilterGroup | null }
  | { type: "SET_SEARCH"; search: string }
  | { type: "SET_PAGE"; page: number; pageSize: number }
  | { type: "CORRECT_PAGE"; page: number }
  | {
      type: "APPLY_URL_STATE";
      page: number;
      pageSize: number;
      sorting: Sort[];
      filters: FilterGroup | null;
      search: string;
    }
  | { type: "NORMALIZE_QUERY"; limits: QueryLimits }
  | { type: "SET_SELECTED_ROW_KEYS"; keys: Key[] }
  | { type: "RELOAD" }
  | { type: "RESET" }
  | { type: "FETCH_START" }
  | { type: "FETCH_SUCCESS"; data: T[]; total: number | null; page: number; pageSize: number }
  | { type: "FETCH_ERROR"; error: Error };

/** The reducer of the table state. It is pure; an action that changes nothing returns the SAME state object. */
export function dataTableReducer<T>(
  state: DataTableState<T>,
  action: DataTableAction<T>,
): DataTableState<T> {
  switch (action.type) {
    case "SET_SORTING":
      return { ...state, sorting: action.sorting, page: 1 };
    case "SET_FILTERS":
      return { ...state, filters: action.filters, page: 1 };
    case "SET_SEARCH":
      return { ...state, search: action.search, page: 1, searchVersion: state.searchVersion + 1 };
    case "SET_PAGE": {
      const pageSizeChanged = action.pageSize !== state.pageSize;
      return { ...state, page: pageSizeChanged ? 1 : action.page, pageSize: action.pageSize };
    }
    case "CORRECT_PAGE":
      return { ...state, page: action.page };
    case "APPLY_URL_STATE":
      // The query that comes from the URL (the first load, or back/forward) is
      // applied in ONE step: separate SET_* actions would each return the page
      // to 1 and overwrite the page in the URL.
      // `searchVersion` increases so that the search box syncs with the term in the URL.
      return {
        ...state,
        page: action.page,
        pageSize: action.pageSize,
        sorting: action.sorting,
        filters: action.filters,
        search: action.search,
        searchVersion: state.searchVersion + 1,
      };
    case "NORMALIZE_QUERY": {
      // When the endpoint meta arrives (or changes), the current query is
      // pulled into the new limits: a sorting that was set up from the URL or
      // before the meta may name a field the endpoint does not allow sorting
      // on, and the search may exceed a length that has narrowed. When nothing
      // changes, the SAME state is returned, so there is no needless render or
      // new query. Filters are not pruned (the same principle as the URL
      // design); the whitelist is the backend's job.
      const { maxPageSize, maxSearchLength, sortableFields } = action.limits;
      const pageSize = maxPageSize ? Math.min(state.pageSize, maxPageSize) : state.pageSize;
      const sorting = state.sorting.filter((s) => sortableFields.has(s.field));
      const search = state.search.slice(0, maxSearchLength);
      const sortingChanged = sorting.length !== state.sorting.length;
      if (pageSize === state.pageSize && !sortingChanged && search === state.search) return state;
      return {
        ...state,
        pageSize,
        sorting: sortingChanged ? sorting : state.sorting,
        search,
        searchVersion: search === state.search ? state.searchVersion : state.searchVersion + 1,
      };
    }
    case "SET_SELECTED_ROW_KEYS":
      return { ...state, selectedRowKeys: action.keys };
    case "RELOAD":
      return { ...state, reloadToken: state.reloadToken + 1 };
    case "RESET":
      return {
        ...createInitialState<T>(),
        data: state.data,
        total: state.total,
        loading: state.loading,
        error: state.error,
        // This DELIBERATELY continues from the PREVIOUS state rather than from
        // the 0 of `createInitialState()`: the counter has to advance even when
        // no other search dispatch happens between two consecutive reset()
        // calls (see the field comment above).
        searchVersion: state.searchVersion + 1,
      };
    case "FETCH_START":
      return { ...state, loading: true };
    case "FETCH_SUCCESS":
      return {
        ...state,
        data: action.data,
        /**
         * On `skipCount` requests the backend returns `total: null`. In that
         * case the LAST KNOWN total is kept, because resetting it would hide
         * the pagination entirely. The table's own query never sends
         * `skipCount` (only the paged export requests do), so this branch is
         * unreachable today; if the table query starts to use `skipCount`, the
         * fact that the kept value may be stale has to be written into the
         * `TableInstance.pagination.total` contract.
         */
        total: action.total ?? state.total,
        page: action.page,
        pageSize: action.pageSize,
        loading: false,
        error: null,
      };
    case "FETCH_ERROR":
      return { ...state, loading: false, error: action.error };
    default:
      return state;
  }
}

/** The query at the moment a request was sent (see `isSameRequest`). */
export type RequestSnapshot = Pick<DataTableState<unknown>, "page" | "pageSize" | "sorting" | "filters" | "search" | "reloadToken">;

/** Captures the query-defining fields of `state`. */
export function requestSnapshot(state: RequestSnapshot): RequestSnapshot {
  const { page, pageSize, sorting, filters, search, reloadToken } = state;
  return { page, pageSize, sorting, filters, search, reloadToken };
}

/**
 * Does the response of a request that was sent with `snapshot` still belong to
 * the CURRENT query? The sequence number (`sequenceRef`) increases only when
 * the fetch effect runs. Between the query state changing and the effect
 * running (one render plus a paint after an event outside React), an old
 * response that comes back would still pass the sequence check, and
 * `FETCH_SUCCESS` would overwrite the `page: 1` of the new search with the old
 * page. The comparison is by reference on purpose: sorting and filters change
 * only through an action, and a new object with equal content also triggers a
 * new query.
 */
export function isSameRequest(state: RequestSnapshot, snapshot: RequestSnapshot): boolean {
  return (
    state.page === snapshot.page &&
    state.pageSize === snapshot.pageSize &&
    state.sorting === snapshot.sorting &&
    state.filters === snapshot.filters &&
    state.search === snapshot.search &&
    state.reloadToken === snapshot.reloadToken
  );
}