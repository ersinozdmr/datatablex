import { decodeFilterParam, encodeFilterParam, filtersEqual } from "@datatablex/core";
import type { FilterGroup, Sort } from "@datatablex/core";

/**
 * The query state that `syncWithUrl` translates between the querystring and
 * the table. The translation is done by pure functions that do not depend on
 * React. Only the shareable QUERY is written to the URL; column state, density
 * and selection are not.
 */
export interface UrlQueryState {
  /** The current page, 1-based. */
  page: number;
  /** The number of rows per page. */
  pageSize: number;
  /** The active sorting. */
  sorting: Sort[];
  /** The search term. */
  search: string;
  /** The filter tree. */
  filters: FilterGroup | null;
}

/** How the URL is read and written (see `readUrlState` and `writeUrlState`). */
export interface UrlStateOptions {
  /** The key prefix for several tables on the same page: `logs` gives `logs.page`, `logs.f`. */
  prefix?: string;
  /** The value that applies when the URL has no `pageSize`; a value equal to the default is not written to the URL. */
  defaultPageSize: number;
  /** The largest page size allowed; a larger value in the URL is clamped. No cap when it is not given. */
  maxPageSize?: number;
  /** The search term is not truncated when this is not given. */
  maxSearchLength?: number;
  /**
   * The fields that can be sorted: a sorting on any other field that comes from
   * the URL is dropped (otherwise there would be a visible 400). When it is not
   * given, fields are not filtered, in order to read the RAW content of the URL
   * (see the query-to-URL write in `useDataTable`).
   */
  sortableFields?: ReadonlySet<string>;
}

/** Returns the URL parameter names of a table, with the optional `prefix` applied. */
export function urlKeys(prefix?: string) {
  const key = (name: string) => (prefix ? `${prefix}.${name}` : name);
  return { page: key("page"), pageSize: key("pageSize"), sort: key("sort"), search: key("search"), filters: key("f") };
}

function positiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseSorting(raw: string | null, sortable: ReadonlySet<string> | undefined): Sort[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const sorting: Sort[] = [];
  for (const part of raw.split(",")) {
    const separator = part.lastIndexOf(":");
    const field = part.slice(0, separator);
    const direction = part.slice(separator + 1);
    if (separator <= 0 || (direction !== "asc" && direction !== "desc")) continue;
    if ((sortable && !sortable.has(field)) || seen.has(field)) continue;
    seen.add(field);
    sorting.push({ field, direction });
  }
  return sorting;
}

/**
 * URL to query state. The URL is untrusted input, and invalid values are
 * handled by class: the page and the page size fall back to the default or are
 * clamped, a field that cannot be sorted is dropped, and the search is
 * truncated. The filter tree is validated only for its shape and is NOT
 * PRUNED: external nodes that dashboards inject are legitimate, and the
 * whitelist is the backend's job.
 */
export function readUrlState(params: URLSearchParams, options: UrlStateOptions): UrlQueryState {
  const keys = urlKeys(options.prefix);
  const pageSize = positiveInt(params.get(keys.pageSize)) ?? options.defaultPageSize;
  const rawFilters = params.get(keys.filters);
  return {
    page: positiveInt(params.get(keys.page)) ?? 1,
    pageSize: options.maxPageSize ? Math.min(pageSize, options.maxPageSize) : pageSize,
    sorting: parseSorting(params.get(keys.sort), options.sortableFields),
    search: (params.get(keys.search) ?? "").slice(0, options.maxSearchLength ?? Infinity),
    filters: rawFilters ? decodeFilterParam(rawFilters) : null,
  };
}

/**
 * Query state to a new querystring. Only this table's keys are written or
 * removed; other parameters (the application's own `tab=...`, the prefixed
 * keys of another table) stay as they are. Default values (`page=1`, the
 * default `pageSize`, an empty search, sorting or filter) are not written; what
 * is written is added in a fixed order, so that two equivalent states produce
 * the same text.
 */
export function writeUrlState(current: URLSearchParams, state: UrlQueryState, options: UrlStateOptions): URLSearchParams {
  const keys = urlKeys(options.prefix);
  const next = new URLSearchParams(current);
  for (const key of Object.values(keys)) next.delete(key);
  if (state.page !== 1) next.set(keys.page, String(state.page));
  if (state.pageSize !== options.defaultPageSize) next.set(keys.pageSize, String(state.pageSize));
  if (state.sorting.length) next.set(keys.sort, state.sorting.map((s) => `${s.field}:${s.direction}`).join(","));
  if (state.search) next.set(keys.search, state.search);
  if (state.filters) next.set(keys.filters, encodeFilterParam(state.filters));
  return next;
}

/**
 * The LOGICAL equality of two states, which is the basis of echo suppression:
 * when they are equal, neither is the URL written nor is a new query sent.
 * Filters are compared with `filtersEqual`; two trees whose children are in a
 * different order but mean the same are equal.
 */
export function urlStateEqual(a: UrlQueryState, b: UrlQueryState): boolean {
  return (
    a.page === b.page &&
    a.pageSize === b.pageSize &&
    a.search === b.search &&
    a.sorting.length === b.sorting.length &&
    a.sorting.every((s, i) => s.field === b.sorting[i]!.field && s.direction === b.sorting[i]!.direction) &&
    filtersEqual(a.filters, b.filters)
  );
}
