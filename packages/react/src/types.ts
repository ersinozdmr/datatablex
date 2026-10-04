import type { ReactNode, Key } from "react";
import type { DataSource, DataTableColumn, DataTableServerExportFormat, DataTableServerExportScope, FilterGroup, Sort } from "@datatablex/core";
import type { DocumentExporter } from "./export/exporter.js";

/**
 * The React extension of `DataTableColumn`. The `title: string` limit of core
 * is lifted here, so a heading can carry a tooltip, an icon or a badge. The
 * export fields (`exportTitle`, `exportValue`, `exportable`) control how the
 * column appears in an exported file.
 *
 * @example
 * ```tsx
 * const columns: ReactDataTableColumn<User>[] = [
 *   // `key` alone: it is also the backend field and the way the value is read.
 *   { key: "name", title: "Name", type: "text", sortable: true, filterable: true },
 *   // `field` names the backend field when it differs from `key`.
 *   { key: "created", field: "createdAt", title: "Created", type: "datetime", sortable: true },
 *   // `accessor` reads the displayed value from the record; `field: null`
 *   // marks a computed column with no backend counterpart.
 *   { key: "fullName", field: null, title: "Full name", accessor: (user) => `${user.first} ${user.last}` },
 * ];
 * ```
 */
export interface ReactDataTableColumn<T> extends Omit<DataTableColumn<T>, "title"> {
  /** The column heading; any React node. */
  title: ReactNode;
  /** The heading used in exported files. Falls back to `title` when it is a string, otherwise to `key`. */
  exportTitle?: string;
  /** Renders the body cell. Receives the raw value, the record and the row index. */
  render?: (value: unknown, record: T, index: number) => ReactNode;
  /** The value of the export cell. When given, its result is used AS IS: `null` is an empty cell, and the raw value is not used as a fallback (for redaction). */
  exportValue?: (record: T) => string | number | boolean | Date | null;
  /** Set to `false` to leave the column out of exported files. */
  exportable?: boolean;
  /** Render body cells in AntD's code font (`token.fontFamilyCode`), for fixed-width values such as dates and times, IDs and codes. Does NOT affect the heading. */
  monospace?: boolean;
  /** Render numeric characters with equal widths (`font-variant-numeric: tabular-nums`). Does NOT affect the heading. */
  tabularNums?: boolean;
  /**
   * The state of the options that come from the server. `useDataTable` writes
   * it; a column definition does NOT provide it. It appears only on an enum
   * column that has no hand-written `options` and whose field is reported with
   * `hasOptions` by the endpoint meta: `"idle"` means the options have not been
   * requested yet (`table.loadOptions(field)` starts the request), `"loading"`
   * means a request is in flight, `"ready"` means `options` has been filled in,
   * `"error"` means the request failed. An empty list or an error turns the
   * column's filter off (`filterable: false`).
   *
   * @experimental May change in any release while the package is in 0.x.
   */
  optionsState?: ColumnOptionsState;
}

/** The state of the server-provided options of an enum column (see `ReactDataTableColumn.optionsState`). */
export type ColumnOptionsState = "idle" | "loading" | "ready" | "error";

/**
 * Row density. "small", "middle" and "large" are EXACTLY the names of AntD's
 * `<Table size>`. "compact", "xsmall" and "mini" have NO counterpart in AntD:
 * they are tighter sizes specific to DataTableX, applied on top of AntD's
 * smallest native size ("small") with custom cell padding (see
 * `@datatablex/antd`, `density.ts`).
 */
export type Density = "mini" | "xsmall" | "compact" | "small" | "middle" | "large";

/**
 * The persistent state of column management. It is written to localStorage and
 * NOT to the URL. `order` is the FINAL (0-based) position in the array: raw
 * `order` values passed to `setColumnState` from outside are reassigned while
 * they are normalized, so the persisted record always carries a consistent
 * order.
 */
export interface ColumnState {
  /** The `key` of the column this entry describes. */
  key: string;
  /** Whether the column is hidden. */
  hidden?: boolean;
  /** The column width. */
  width?: number;
  /** The 0-based position of the column. */
  order: number;
  /**
   * Whether cell content wraps onto several lines. `false` renders a single
   * line with an ellipsis.
   *
   * @default true
   */
  wrap?: boolean;
}

/**
 * The interface through which `syncWithUrl` reads and writes the URL.
 * `syncWithUrl: true` uses the default `window.history` adapter; an app that
 * uses a router passes its own adapter that manages the URL through the
 * router, because writing to `history` without the router knowing leaves the
 * router's parameters stale.
 *
 * @example
 * ```ts
 * // A minimal adapter over `window.location` and `window.history`.
 * const adapter: UrlStateAdapter = {
 *   get: () => new URLSearchParams(window.location.search),
 *   set: (params, options) => {
 *     const url = `${window.location.pathname}?${params.toString()}`;
 *     if (options?.replace) window.history.replaceState(null, "", url);
 *     else window.history.pushState(null, "", url);
 *   },
 *   // Optional: without it the sync is one-way (see `subscribe`).
 *   subscribe: (onChange) => {
 *     window.addEventListener("popstate", onChange);
 *     return () => window.removeEventListener("popstate", onChange);
 *   },
 * };
 * ```
 */
export interface UrlStateAdapter {
  /** Returns the current query parameters of the URL. */
  get: () => URLSearchParams;
  /** `replace: true` means do not create a history entry (search, filter, sorting); otherwise the URL is pushed (page change). */
  set: (params: URLSearchParams, options?: { replace?: boolean }) => void;
  /**
   * Listens for the URL changing from OUTSIDE (the back/forward button, router
   * navigation) and returns the function that ends the subscription. When it
   * is not given, the sync is one-way: the back button changes the URL but the
   * table stays in its old state.
   */
  subscribe?: (onChange: () => void) => () => void;
}

/**
 * The options of `useDataTable`. The export thresholds are client-side
 * guards that the frontend aligns, in writing, with the limits of the backend.
 *
 * @example
 * ```tsx
 * const table = useDataTable<User>({
 *   dataSource: createRestDataSource<User>({ endpoint: "/api/users/query" }),
 *   rowKey: "id",
 *   tableId: "users",
 *   columns: [
 *     { key: "name", title: "Name", type: "text", sortable: true, filterable: true },
 *     { key: "email", title: "Email", type: "text", searchable: true },
 *   ],
 *   syncWithUrl: true,
 *   awaitMeta: true,
 * });
 * ```
 */
export interface UseDataTableOptions<T> {
  /** Where the rows come from: a REST endpoint, a local array, or your own `DataSource`. */
  dataSource: DataSource<T>;
  /**
   * The IDENTITY of `dataSource` is NOT a fetch dependency (see the
   * `reload()` documentation); this is deliberate, so that unstable inline
   * objects cannot produce an endless fetch loop. On a screen that changes
   * `dataSource` ON PURPOSE (for example the active tenant, account or endpoint
   * id), if this field is not given, both the direct hook and the
   * `<DataTable dataSource={...}>` shortcut keep showing the old source; with
   * the shortcut, the caller does not even have access to `reload()`. When
   * its value changes, the new `dataSource` is queried automatically; both API
   * forms share the same contract.
   */
  dataSourceKey?: string | number;
  /** The column definitions. The rendered set is `TableInstance.columns`, which is narrowed by the endpoint meta. */
  columns: ReactDataTableColumn<T>[];
  /**
   * The same contract as AntD Table's `rowKey`. The value it produces must
   * match EXACTLY the counterpart of the backend's primaryKey field in the
   * response.
   */
  rowKey: Extract<keyof T, string> | ((record: T) => Key);
  /**
   * The localStorage key of the column state. When it is not given,
   * persistence is completely off (an explicit opt-in instead of a silent
   * global collision). If it changes at runtime, the hook reads the record
   * stored under the NEW key (and falls back to the default when there is
   * none); the read key and the write key always stay in sync.
   */
  tableId?: string;
  /**
   * The version of the persisted column state. Increase it when the column set
   * changes; a stored record that cannot be reconciled is discarded. Like
   * `tableId`, it reacts to a change at runtime.
   *
   * @default 1
   */
  schemaVersion?: number;
  /**
   * The row density. It is read only on the FIRST render: a later change has
   * no effect, use `table.setDensity` instead.
   *
   * @default "middle"
   */
  density?: Density;
  /**
   * The density of the header row. When it is not given, it takes the INITIAL
   * value of `density` (or of "middle" when that is not given either); when it
   * is given separately, the header becomes INDEPENDENT of the body. Like
   * `density`, it is read only on the FIRST render; use `table.setHeaderDensity`
   * afterwards.
   *
   * @default the initial value of `density`
   */
  headerDensity?: Density;
  /**
   * The maximum number of characters of the search term. It must carry the SAME
   * value as the backend's `DataTableEndpointConfig.maxSearchLength`, one of
   * the contracts that are aligned by hand. The search box truncates at this
   * length and `setSearch` cuts off the excess; otherwise a long paste would
   * get a 400 from the server.
   *
   * @default 200
   */
  maxSearchLength?: number;
  /**
   * The maximum number of keys in a single `in` request when the selected rows
   * are exported.
   *
   * @default 500
   */
  exportChunkSize?: number;
  /**
   * Synchronizes the query (page, page size, sorting, search, filter tree) with
   * the URL in both directions. Column state, density and selection are not
   * written to the URL. When it is on, the first query waits until the URL has
   * been read. Pass `true` for the default `window.history` adapter, or a
   * `UrlStateAdapter` for a router. Off when omitted.
   */
  syncWithUrl?: boolean | UrlStateAdapter;
  /** The key prefix of the URL parameters, for several synchronized tables on the same page: `"logs"` gives `logs.page`, `logs.f`. */
  urlParamPrefix?: string;
  /**
   * Adapters for the formats that are produced in memory, such as Excel and
   * PDF; CSV is always available. The ready-made ones are `excelExporter`
   * (`@datatablex/react/excel`, needs `exceljs`) and `pdfExporter`
   * (`@datatablex/react/pdf`, needs `pdfmake`). An inline array may be given;
   * a change of its identity produces neither a new query nor a new
   * `TableInstance`.
   */
  exporters?: readonly DocumentExporter[];
  /**
   * When `true`, and the DataSource offers `getMeta`, the first query waits
   * for the endpoint meta: the state that comes from the URL is normalized with
   * the meta limits, and a SINGLE canonical request is sent. If the meta
   * fails, or `timeoutMs` (3000 by default) runs out, the query goes on with
   * the limits given by hand. With a cached meta the wait is practically zero.
   * When `false`, the first query does not wait for the meta; the query is
   * normalized when the meta arrives.
   *
   * @default false
   */
  awaitMeta?: boolean | { timeoutMs?: number };
  /**
   * Filters given by the application that the user cannot remove (for example
   * a dashboard context, or a per-tab pre-filter). At query time and for an
   * `allFiltered` export they are combined with the user's `filters` using
   * `AND`; they do not enter `table.filters`, are not written to the URL, and
   * `reset()` and `setFilters(null)` do not touch them. When their content
   * changes the page returns to 1; a change of identity does not produce a new
   * query. A `selected` export works only with the selected keys (the
   * selection is not combined with the locked filter).
   *
   * This is NOT A SECURITY BOUNDARY: it runs on the client. For data the user
   * must not see, use the backend's `scope`.
   */
  lockedFilters?: FilterGroup | null;
  /**
   * The maximum number of rows of a file produced in browser memory on the
   * client path (a source with no server export): a number applies to all
   * three formats, an object applies per format. The defaults are 100 000 for
   * CSV, 50 000 for Excel and 10 000 for PDF (an Excel file of 100K rows takes
   * about 700 MB). When the limit is exceeded, the export stops before it
   * starts with `ExportRowLimitError`. You can raise it on purpose (`Infinity`
   * means unlimited); with wide cells the row count alone is NOT the memory
   * limit, so use the server export for large data. On the server path the
   * ceiling is the server's `export.maxRows`.
   *
   * @default { csv: 100_000, excel: 50_000, pdf: 10_000 }
   */
  maxClientExportRows?: number | { csv?: number; excel?: number; pdf?: number };
}

/**
 * The limits the client follows, narrowed by the backend (see
 * `TableInstance.limits`). A filter limit of `null` means "there is no
 * endpoint meta": the consumer applies its own default (the filter bar of
 * `<DataTable>`: 50 rules, 3 levels, 500 values).
 */
export interface TableLimits {
  /** The smaller of the hand-given `maxSearchLength` and the one in the meta. */
  maxSearchLength: number;
  /** The maximum number of filter rules, or `null` when there is no meta. */
  maxFilterCount: number | null;
  /** The maximum nesting depth of the filter tree, or `null` when there is no meta. */
  maxFilterDepth: number | null;
  /** The maximum number of values in one `in` or `notIn` rule, or `null` when there is no meta. */
  maxInValues: number | null;
}

/** An export format: `"csv"`, `"excel"` or `"pdf"`. */
export type ExportFormat = DataTableServerExportFormat;
/** What an export covers: `"allFiltered"`, `"currentPage"` or `"selected"`. */
export type ExportScope = DataTableServerExportScope;

/**
 * The controller contract that `useDataTable` returns and that
 * `<DataTable table={...}>` reads. It can also be implemented by hand (a mock,
 * a test wrapper, a bridge to another state library). `<DataTable>` (in
 * `@datatablex/antd`) reads only the public members of the instance, so an
 * implementation has to uphold these rules:
 *
 * - The instance must be stable. The object that `useDataTable` returns is
 *   memoized: it gets a new identity only when something it carries changes.
 *   Keep that property, because a consumer that writes `useEffect(..., [table])`
 *   or wraps children in `React.memo` depends on it.
 * - `columns` and `limits` get a new reference only when their sources change,
 *   not on every render. For `columns` the sources are the `columns` option,
 *   the endpoint metadata and the filter options loaded from the server; for
 *   `limits` they are the `maxSearchLength` option and the endpoint metadata.
 * - `columns` are the columns to render: the `columns` option narrowed to what
 *   the backend allows when endpoint metadata is available.
 * - `limits` are the limits the client follows, narrowed by the backend. A
 *   filter limit that is `null` means "no metadata: apply your own default".
 * - `searchRevision` increases every time a search change is REQUESTED
 *   (`setSearch`, `reset`, the URL), even when the value stays the same. An
 *   external search box uses it to cancel its pending debounced input.
 * - `tableId` is the persistence key (column state, selection column
 *   visibility); it is `undefined` when it was not given.
 * - New members are added only as optional in minor releases, and
 *   `<DataTable>` tolerates their absence. An implementation does not have to
 *   provide the optional members.
 */
export interface TableInstance<T> {
  /** The rows of the current page. */
  data: T[];
  /** Whether a query is in flight. */
  loading: boolean;
  /** The error of the last query, or `null`. */
  error: Error | null;
  /** The pagination state and its change handler. */
  pagination: {
    /** The current page, 1-based. */
    current: number;
    /** The number of rows per page. */
    pageSize: number;
    /** The total number of rows. */
    total: number;
    /** Called when the page or the page size changes. */
    onChange: (page: number, pageSize: number) => void;
  };
  /** The active sorting. */
  sorting: Sort[];
  /** Returns the page to 1. */
  setSorting: (sorting: Sort[]) => void;
  /** The user's filters: the tree that is written to the URL and edited by the UI. It does NOT contain the locked filters. */
  filters: FilterGroup | null;
  /** Returns the page to 1. */
  setFilters: (filters: FilterGroup | null) => void;
  /**
   * The effective value of the `lockedFilters` option (read-only; an invalid or
   * empty group is `null`). It goes to the query and to the export combined
   * with `filters` using `AND`.
   */
  lockedFilters: FilterGroup | null;
  /** The current search term. */
  search: string;
  /** Returns the page to 1 (after the debounce). */
  setSearch: (term: string) => void;
  /** The keys of the selected rows. They are KEPT when the page, filter, search or sorting changes; only `reset()` clears them. */
  selectedRowKeys: Key[];
  /** Replaces the selection. */
  setSelectedRowKeys: (keys: Key[]) => void;
  /** Visibility, order and width, reconciled with the `columns` option. */
  columnState: ColumnState[];
  /** Hide/show, reorder and resize all go through this single setter. */
  setColumnState: (next: ColumnState[]) => void;
  /** Deletes the stored state and returns to the defaults in the `columns` option. */
  resetColumns: () => void;
  /** The density of the body rows. */
  density: Density;
  /** Changes the density of the body rows. */
  setDensity: (density: Density) => void;
  /**
   * The density of the header row. When the `headerDensity` option is not
   * given, it takes the INITIAL value of `density` on the first render, but
   * that is a one-time copy: the two are INDEPENDENT states, and a later
   * `setDensity` does NOT affect `headerDensity`.
   */
  headerDensity: Density;
  /** Changes the density of the header row. */
  setHeaderDensity: (density: Density) => void;
  /** Runs the current query again and keeps the page. The promise settles when that fetch finishes. */
  reload: () => Promise<void>;
  /** Resets the query state (page, sorting, filter, search, selection). It does NOT touch the column state or the density. */
  reset: () => void;
  /**
   * Downloads the file; `allFiltered` is used when no scope is given. When the
   * source offers a server export and the meta reports that format through the
   * ticket route, the server produces the file and the browser downloads it
   * itself; otherwise the file is produced in the browser. `"started"` reports
   * that the download began, `"cancelled"` that it did not (a cancel, an
   * unmount, or another export in progress). `title` is the PDF heading (a
   * built-in default is used when it is not given; `<DataTable>` passes one
   * from its locale). `currentPage` is rejected while the table is loading,
   * because the data on the screen may belong to the previous query.
   */
  exportData: (format: ExportFormat, scope?: ExportScope, options?: { filename?: string; title?: string }) => Promise<ExportOutcome>;
  /** Stops the export in progress: on the server path the ticket request is aborted, on the client path the page requests are. Once the download has started, cancelling is up to the browser. */
  cancelExport: () => void;
  /** No second cycle is started while an export is in progress. On the server path this is true only until the ticket is obtained. */
  isExporting: boolean;
  /** The progress of a paged export on the client path; `null` on the server path and outside an export. */
  exportProgress: { current: number; total: number } | null;
  /** The export formats that are available: `"csv"`, those registered with `exporters`, and those the server produces through the ticket route (once the meta arrives). */
  readonly exportFormats: readonly ExportFormat[];
  /**
   * When `true`, the `selected` scope cannot be exported: the endpoint meta is
   * known and the string `rowKey` differs from the backend's `primaryKey`
   * (`exportData(..., "selected")` is rejected with the `export_selection_key`
   * code). It is optional; on a hand-built `TableInstance` its absence counts
   * as `false`.
   */
  readonly exportSelectionBlocked?: boolean;
  /**
   * The columns to render: the `columns` option, with the filter and sorting
   * capabilities the backend does not allow turned off when endpoint meta is
   * available.
   */
  readonly columns: ReactDataTableColumn<T>[];
  /** The `rowKey` option, as given. */
  readonly rowKey: Extract<keyof T, string> | ((record: T) => Key);
  /** The persistence key (column state, selection column visibility); `undefined` when not given. */
  readonly tableId: string | undefined;
  /** The limits the client follows, narrowed by the backend. */
  readonly limits: TableLimits;
  /**
   * Requests the server-side options of an enum field; the result is written to
   * the `options` and `optionsState` fields of the column in `columns`. It
   * takes effect only for the field of a column that carries `optionsState`; a
   * request that is in flight or finished is not repeated, and in the `"error"`
   * state it is retried. It is called when the value editor opens; for columns
   * that have an active rule, the hook calls it itself. It exists only when
   * the DataSource offers `getOptions`, and a hand-built `TableInstance` may
   * lack it as well.
   *
   * @experimental May change in any release while the package is in 0.x.
   */
  readonly loadOptions?: (field: string) => void;
  /**
   * Increases every time a search change is REQUESTED (`setSearch`, `reset()`,
   * the URL), even when the value stays the same (for example `reset()` while
   * the search is already empty). A search box outside the table cancels its
   * input that is waiting for the debounce when this value changes, and
   * synchronizes with `search`.
   */
  readonly searchRevision: number;
}

/** The result of `exportData`: the download started, or it did not (a cancel, an unmount, or another export in progress). */
export type ExportOutcome = "started" | "cancelled";
