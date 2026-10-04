import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Key } from "react";
import { DATATABLEX_PROTOCOL_VERSION, andFilterGroups, canonicalFilterKey, columnField, isFilterGroup } from "@datatablex/core";
import type { DataSource, DataTableEndpointMeta, DataTableFieldOption, DataTableQuery, FilterGroup, Sort } from "@datatablex/core";
import type { ColumnOptionsState, ColumnState, Density, ExportFormat, ExportOutcome, ExportScope, TableInstance, TableLimits, UrlStateAdapter, UseDataTableOptions } from "../types.js";
import { downloadExport, exportColumnsFor, serverExportColumnsFor, startDownload } from "../export/exportFile.js";
import { DataTableExportError, ExportBusyError, ExportRowLimitError } from "../export/errors.js";
import { DataTableRequestError } from "../query/createRestDataSource.js";
import type { DocumentExporter } from "../export/exporter.js";
import { DEFAULT_PAGE_SIZE, createInitialState, dataTableReducer, isSameRequest, requestSnapshot } from "./reducer.js";
import type { DataTableAction } from "./reducer.js";
import { createHistoryAdapter } from "./historyAdapter.js";
import { readUrlState, urlStateEqual, writeUrlState } from "./urlState.js";
import type { UrlQueryState, UrlStateOptions } from "./urlState.js";
import { applyEndpointMeta } from "./endpointMeta.js";
import {
  clearColumnStateRecord,
  columnStateEqual,
  normalizeColumnState,
  readColumnStateRecord,
  writeColumnStateRecord,
} from "./columnState.js";

/** Same as the default of the backend `DataTableEndpointConfig.maxSearchLength`. */
const DEFAULT_MAX_SEARCH_LENGTH = 200;
const DEFAULT_EXPORT_CHUNK_SIZE = 500;
/**
 * On the client path (a source without server export) the file is produced in
 * browser memory: all rows are collected in `rows[]`, and CSV additionally builds
 * row arrays, a single string and a Blob. The ceilings are based on measurements:
 * an Excel file of 100K rows takes ~6.5 s and ~700 MB (hence the default of 50K), and a
 * PDF of 10K rows takes ~3.4 s and ~340 MB (PDF generation freezes the tab). CSV is
 * NOT unlimited either (100K); beyond that, use server export or raise the ceiling
 * explicitly.
 */
const DEFAULT_MAX_CLIENT_EXPORT_ROWS: Record<ExportFormat, number> = { csv: 100_000, excel: 50_000, pdf: 10_000 };
const EXPORT_EXTENSION: Record<ExportFormat, string> = { csv: "csv", excel: "xlsx", pdf: "pdf" };

function clientExportLimit(option: UseDataTableOptions<unknown>["maxClientExportRows"], format: ExportFormat): number {
  if (typeof option === "number") return option;
  return option?.[format] ?? DEFAULT_MAX_CLIENT_EXPORT_ROWS[format];
}

/** The formats the server produces through the ticket path, with their ceilings; `null` when the meta does not declare an `export` block. */
function serverExportLimits(meta: DataTableEndpointMeta | null): Partial<Record<ExportFormat, number>> | null {
  const block = meta?.export;
  if (!block) return null;
  const limits: Partial<Record<ExportFormat, number>> = {};
  for (const format of Object.keys(EXPORT_EXTENSION) as ExportFormat[]) {
    const limit = block.formats[format];
    if (typeof limit === "number") limits[format] = limit;
  }
  return limits;
}
/** With `awaitMeta: true`, the meta is awaited for at most this long; after that the query runs with the manually supplied limits. */
const DEFAULT_AWAIT_META_TIMEOUT_MS = 3000;
/** Used when no export title is given (`@datatablex/antd` passes one from its own locale). */
const DEFAULT_EXPORT_TITLE = "Export";

/** The options of a field requested from the server; `options` is present only in the `ready` status. */
interface FieldOptionsEntry {
  status: Exclude<ColumnOptionsState, "idle">;
  options?: DataTableFieldOption[];
}
const NO_FIELD_OPTIONS: Record<string, FieldOptionsEntry> = {};

/** The fields of the leaves in a filter tree. */
function filterFields(group: FilterGroup | null, into = new Set<string>()): Set<string> {
  for (const node of group?.filters ?? []) {
    if ("filters" in node) filterFields(node, into);
    else into.add(node.field);
  }
  return into;
}

interface PendingReload {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Without `window` (SSR), `useLayoutEffect` emits a console warning ("does
 * nothing on the server"); falling back to `useEffect` silences that warning, and
 * no effect runs on the server anyway. On the client `useLayoutEffect` is used so
 * that the localStorage correction is applied before the DOM is painted (see the
 * column state hydration effect below).
 */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * `dataSource` is NOT an effect DEPENDENCY: its identity is carried in a ref.
 *
 * If it were a dependency, a calling component that creates `dataSource` in its
 * own body (the case covered by the warning in the documentation) would close
 * this loop: the effect runs, `FETCH_START` produces a new state object, the
 * component re-renders, a new `dataSource` reference appears, and the effect
 * runs again. The loop does not depend on the fetch resolving, so it locks up
 * the browser tab; when measured, it crashed the vitest worker.
 *
 * Trade-off: changing `dataSource` ON PURPOSE (for example to switch to another
 * endpoint) does not trigger a new query by itself. There are two ways: calling
 * `reload()` (possible only when using the hook directly, where the
 * `TableInstance` is at hand) or changing `dataSourceKey` (works in both API
 * shapes; see `UseDataTableOptions.dataSourceKey`). If neither is done, the table
 * silently shows stale data, so a warning makes this visible once in dev builds.
 */
function useLatestDataSource<T>(dataSource: DataSource<T>, dataSourceKey: string | number | undefined) {
  const ref = useRef(dataSource);
  const keyRef = useRef(dataSourceKey);
  const warnedRef = useRef(false);

  useEffect(() => {
    const keyChanged = keyRef.current !== dataSourceKey;
    keyRef.current = dataSourceKey;
    if (ref.current === dataSource) return;
    ref.current = dataSource;

    // If `dataSourceKey` changed too, the query was ALREADY re-run (it is a
    // dependency of the fetch effect). Warning would be factually wrong and would
    // push the developer toward a wrong fix after they did the right thing.
    if (keyChanged) return;

    if (process.env.NODE_ENV !== "production" && !warnedRef.current) {
      warnedRef.current = true;
      console.warn(
        "[datatablex] The `dataSource` reference changed and NO automatic re-query was made. " +
          "If this is intentional, update `dataSourceKey` (works in both API shapes) or, " +
          "when using the hook directly, call `table.reload()` — with the `<DataTable dataSource={...}>` " +
          "shorthand you have no access to the `table` object, so `dataSourceKey` is the only way there. " +
          "If it is accidental, make `dataSource` stable with `useMemo` or define it at module level " +
          "(the reference stability contract).",
      );
    }
  }, [dataSource, dataSourceKey]);

  return ref;
}

/**
 * The headless table state hook and the main entry point of the package. It owns
 * pagination, sorting, filters, search, selection, column state, density, URL
 * synchronization and export, queries the given `dataSource` accordingly, and
 * returns a memoized {@link TableInstance} that any UI can render. A UI component
 * such as `<DataTable>` is a thin layer that renders the result of this hook.
 *
 * `dataSource` and `columns` must be reference-stable (a module-level constant or
 * `useMemo`). The identity of `dataSource` is not an effect dependency, so
 * replacing it on purpose does not re-query by itself: change `dataSourceKey` or
 * call `table.reload()`. `lockedFilters`, in contrast, is compared by content, so
 * passing a new object on every render is safe.
 *
 * Responses of superseded requests are discarded, so a slow earlier response
 * never overwrites a newer state. `table.exportData()` rejects with a
 * `DataTableExportError` (or one of its subclasses) when an export cannot start;
 * a cancelled export resolves with `"cancelled"` instead.
 *
 * @example
 * ```tsx
 * import { createRestDataSource, useDataTable } from "@datatablex/react";
 * import type { ReactDataTableColumn } from "@datatablex/react";
 *
 * interface AccessLog {
 *   id: number;
 *   accessDate: string;
 *   stadiumName: string;
 * }
 *
 * const columns: ReactDataTableColumn<AccessLog>[] = [
 *   { key: "id", title: "ID" },
 *   { key: "accessDate", title: "Date", type: "datetime", sortable: true },
 *   { key: "stadiumName", title: "Stadium", type: "text", sortable: true, searchable: true },
 * ];
 *
 * const dataSource = createRestDataSource<AccessLog>({ endpoint: "/api/access-logs/query" });
 *
 * export function AccessLogsList() {
 *   const table = useDataTable({ dataSource, columns, rowKey: "id", tableId: "access-logs" });
 *   return (
 *     <div>
 *       <input value={table.search} onChange={(e) => table.setSearch(e.target.value)} />
 *       {table.loading ? <p>Loading…</p> : null}
 *       <ul>
 *         {table.data.map((row) => (
 *           <li key={row.id}>{row.stadiumName}</li>
 *         ))}
 *       </ul>
 *     </div>
 *   );
 * }
 * ```
 */
export function useDataTable<T>(options: UseDataTableOptions<T>): TableInstance<T> {
  const {
    dataSource,
    dataSourceKey,
    rowKey,
    columns,
    tableId,
    schemaVersion = 1,
    density: initialDensity = "middle",
    // When omitted, it copies the INITIAL value of `initialDensity`. This is a
    // one-time copy, read while the initial value of `useState` is computed.
    // After that, `density` and `headerDensity` are two fully independent states.
    headerDensity: initialHeaderDensity = initialDensity,
    maxSearchLength: configuredMaxSearchLength = DEFAULT_MAX_SEARCH_LENGTH,
    exportChunkSize = DEFAULT_EXPORT_CHUNK_SIZE,
    syncWithUrl,
    urlParamPrefix,
    exporters,
    awaitMeta,
    lockedFilters: lockedFiltersOption,
    maxClientExportRows,
  } = options;
  const [state, rawDispatch] = useReducer(dataTableReducer<T>, undefined, createInitialState<T>);
  // The reducer is pure: by applying the same action here synchronously, we keep a
  // mirror that knows "what the query is right now" without waiting for a render.
  // A fetch response is discarded if the query it was sent for is no longer the
  // current one (see `isSameRequest`).
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const dispatch = useCallback((action: DataTableAction<T>) => {
    latestStateRef.current = dataTableReducer(latestStateRef.current, action);
    rawDispatch(action);
  }, []);

  // Locked filters: the CONTENT is tracked, not the identity, so that a consumer
  // passing a new object on every render does not cause a loop. When the content
  // changes, the table returns to page 1 (the same rule as `setFilters`); the
  // update is made during render so that the old page is never queried with the
  // new filter.
  const lockedInput = lockedFiltersOption && isFilterGroup(lockedFiltersOption) && lockedFiltersOption.filters.length ? lockedFiltersOption : null;
  const lockedKey = lockedInput ? canonicalFilterKey(lockedInput) : "";
  const [locked, setLocked] = useState<{ key: string; filters: FilterGroup | null }>(() => ({ key: lockedKey, filters: lockedInput }));
  if (locked.key !== lockedKey) {
    setLocked({ key: lockedKey, filters: lockedInput });
    dispatch({ type: "CORRECT_PAGE", page: 1 });
  }
  const lockedFilters = locked.filters;
  const lockedWarnedRef = useRef(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || lockedWarnedRef.current || !lockedFiltersOption || lockedInput) return;
    lockedWarnedRef.current = true;
    console.warn("[datatablex] lockedFilters is not a valid, non-empty FilterGroup; ignored.");
  }, [lockedFiltersOption, lockedInput]);

  // Column state and density live OUTSIDE the reducer ON PURPOSE: `reset()` resets
  // only the query state, while the RESET branch of the reducer spreads
  // `createInitialState()`. If both lived in the same state, reset() would also
  // silently reset column visibility and density.
  //
  // The first render ALWAYS renders the defaults of `columns`, whatever `tableId`
  // is; localStorage is NOT read here. If it were, on SSR the server (no window)
  // would render the defaults while the client would render the stored state in
  // its first render, and React would silently produce a hydration mismatch. The
  // stored record is applied in the `useIsomorphicLayoutEffect` below, after
  // hydration has completed and IMMEDIATELY before the DOM is painted.
  const [columnState, setColumnStateRaw] = useState<ColumnState[]>(() => normalizeColumnState(null, columns));
  const [density, setDensity] = useState<Density>(initialDensity);
  const [headerDensity, setHeaderDensity] = useState<Density>(initialHeaderDensity);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  // Because React defers state updates to the next render, this ref is used to
  // synchronously block two export clicks that happen in the same tick.
  const exportInFlightRef = useRef(false);
  // The abort handle of the running export; `cancelExport()` and unmount use the same path.
  const exportAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbortRef.current?.abort(), []);

  // Exporters are usually passed as an inline array (`exporters={[excelExporter]}`),
  // which is new on every render. The `TableInstance` identity is renewed only when
  // the AVAILABLE FORMATS change; the exporters themselves are carried in a ref.
  const exportersRef = useRef(exporters);
  useIsomorphicLayoutEffect(() => {
    exportersRef.current = exporters;
  }, [exporters]);
  const exporterFormatsKey = (exporters ?? []).map((e) => e.format).join(",");

  // If `tableId`/`schemaVersion` change at runtime (for example a selector on the
  // same screen that switches the table profile), this effect runs again and reads
  // the record of the NEW key, so the key it reads stays in sync with the key
  // `setColumnState` (below) writes. If the new key has no record,
  // `normalizeColumnState(null, columns)` falls back to the defaults;
  // `columnStateEqual` prevents a needless state update (the defaults were already
  // rendered in the first render).
  useIsomorphicLayoutEffect(() => {
    // If `tableId` becomes falsy (for example "a" -> undefined), persistence is
    // considered OFF by contract: `stored` is `null` too, and the
    // `normalizeColumnState(null, columns)` below renders the defaults of
    // `columns`, not the in-memory state of "a". Otherwise the state of the old
    // identity would silently stay on the new (identity-less) table.
    const stored = tableId ? readColumnStateRecord(tableId, schemaVersion) : null;
    setColumnStateRaw((prev) => {
      const next = normalizeColumnState(stored, columns);
      return columnStateEqual(prev, next) ? prev : next;
    });
    // `columns` is deliberately NOT in the deps: a column change after mount is
    // already covered by the separate reconciliation effect below; this effect
    // reacts only to changes of `tableId`/`schemaVersion`. (Because
    // `useIsomorphicLayoutEffect` has a custom name, `react-hooks/exhaustive-deps`
    // does not analyze this call anyway, so no eslint-disable comment is needed.)
  }, [tableId, schemaVersion]);

  const setColumnState = useCallback(
    (next: ColumnState[]) => {
      const normalized = normalizeColumnState(next, columns);
      setColumnStateRaw(normalized);
      if (tableId) writeColumnStateRecord(tableId, schemaVersion, normalized);
    },
    [columns, tableId, schemaVersion],
  );

  const resetColumns = useCallback(() => {
    // Not `defaultColumnState`: the "at least one visible column" invariant lives
    // in `normalizeColumnState`, and apart from that guard the two functions
    // produce exactly the same output. If `defaultColumnState` were called
    // directly, then for a column set whose columns all carry `defaultHidden: true`,
    // mount would render the first column as visible but resetting the view would
    // empty the table completely, giving two different results for the same
    // invariant on two paths.
    setColumnStateRaw(normalizeColumnState(null, columns));
    if (tableId) clearColumnStateRecord(tableId);
  }, [columns, tableId]);

  /**
   * `columnState` is a derived value. If it were computed only in the `useState`
   * initializer, it would go stale when the `columns` prop changes at runtime
   * (a role-based column set, a user preferences screen): a newly added column
   * would land in the wrong position because of the `order` fallback of
   * `antdColumns`, and a removed column would remain in the panel as a ghost row
   * with working up/down buttons. Because `normalizeColumnState` is idempotent,
   * feeding the previous state back in with the same `columns` is harmless;
   * `columnStateEqual` keeps the previous array reference when the content did
   * not change, which avoids a needless `TableInstance` identity change.
   */
  useEffect(() => {
    setColumnStateRaw((prev) => {
      const next = normalizeColumnState(prev, columns);
      return columnStateEqual(prev, next) ? prev : next;
    });
  }, [columns]);

  // The `columns` reference stability contract already exists; this check runs
  // once, on mount. Mutating a ref during render is unsafe under concurrent
  // rendering and StrictMode (see useLatestDataSource), so it is done inside an
  // effect.
  const columnKeyWarnedRef = useRef(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || columnKeyWarnedRef.current) return;
    const seen = new Set<string>();
    for (const col of columns) {
      if (seen.has(col.key)) {
        columnKeyWarnedRef.current = true;
        console.warn(
          `[datatablex] Duplicate key found in columns: "${col.key}" — column state reconciliation may be unreliable.`,
        );
        break;
      }
      seen.add(col.key);
    }
  }, [columns]);

  // Column roles: sorting and filtering have no effect on a `field: null` column;
  // among columns that share the same `field`, filter rules are bound to the first
  // column. Both are warned about once in dev mode so that they are not silent
  // surprises.
  const columnRoleWarnedRef = useRef(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || columnRoleWarnedRef.current) return;
    const problems: string[] = [];
    const byField = new Map<string, string>();
    for (const col of columns) {
      const field = columnField(col);
      if (field === null) {
        if (col.sortable || col.filterable) problems.push(`"${col.key}" has field: null, so it cannot be sorted or filtered`);
        continue;
      }
      const owner = byField.get(field);
      // A repeated `key` is the subject of the warning above; here only columns with DIFFERENT keys are considered.
      if (owner !== undefined && owner !== col.key) problems.push(`"${col.key}" and "${owner}" share the same field ("${field}"); filter rules are bound to "${owner}"`);
      else byField.set(field, col.key);
    }
    if (!problems.length) return;
    columnRoleWarnedRef.current = true;
    console.warn(`[datatablex] Column roles: ${problems.join("; ")}.`);
  }, [columns]);

  // This must be declared BEFORE the fetch effect below: effects run in
  // declaration order, so the fetch always sees the most recent reference.
  const dataSourceRef = useLatestDataSource(dataSource, dataSourceKey);

  // The endpoint meta only NARROWS: a limit is the smaller of the manually
  // supplied value and the meta value, and columns lose the capabilities the
  // backend does not allow. Until the meta arrives, or if it never does, the
  // manually supplied values apply. By default the first query does NOT wait for
  // the meta; with `awaitMeta` it does.
  // The meta is stored together with the `dataSourceKey` it belongs to: in the
  // first render after the key changes, the meta of the old source is no longer
  // applied (limits return to the manually supplied ones) and `awaitMeta` does
  // not mistake it for the meta of the new source.
  const [metaEntry, setMetaEntry] = useState<{ key: string | number | undefined; meta: DataTableEndpointMeta } | null>(null);
  const meta = metaEntry !== null && metaEntry.key === dataSourceKey ? metaEntry.meta : null;
  // Available formats: CSV, the registered client exporters and what the server
  // produces through the ticket path (added once the meta arrives).
  const serverLimits = dataSource.requestExport ? serverExportLimits(meta) : null;
  const serverFormatsKey = serverLimits ? Object.keys(serverLimits).join(",") : "";
  const exportFormats = useMemo<readonly ExportFormat[]>(() => {
    const split = (key: string) => (key ? (key.split(",") as ExportFormat[]) : []);
    return [...new Set<ExportFormat>(["csv", ...split(exporterFormatsKey), ...split(serverFormatsKey)])];
  }, [exporterFormatsKey, serverFormatsKey]);
  // A `selected` export matches the selected rows by the backend `primaryKey`: if
  // the meta is known and a string `rowKey` differs from it, the request may be
  // applied to ANOTHER field of the same type and download the wrong rows. This
  // known mismatch is rejected in production too (fail-closed); a function
  // `rowKey` already rejects a `selected` export. Without a meta, the contract
  // stays open.
  const exportSelectionBlocked = meta !== null && typeof rowKey === "string" && rowKey !== meta.primaryKey;
  // The "meta wait is over" state is kept PER `dataSourceKey` and compared during
  // render: in the first render after the key changes, the wait restarts
  // immediately, so no request slips through with the old meta.
  const awaitsMeta = Boolean(awaitMeta);
  const waitsForMeta = awaitsMeta && typeof dataSource.getMeta === "function";
  const metaTimeoutMs = typeof awaitMeta === "object" && awaitMeta.timeoutMs !== undefined ? awaitMeta.timeoutMs : DEFAULT_AWAIT_META_TIMEOUT_MS;
  const [metaSettledFor, setMetaSettledFor] = useState<{ key: string | number | undefined } | null>(null);
  const metaSettled = !waitsForMeta || (metaSettledFor !== null && metaSettledFor.key === dataSourceKey);
  const settleMeta = useCallback((key: string | number | undefined) => {
    setMetaSettledFor((prev) => (prev !== null && prev.key === key ? prev : { key }));
  }, []);
  useEffect(() => {
    const getMeta = dataSourceRef.current.getMeta?.bind(dataSourceRef.current);
    if (!getMeta) return;
    const key = dataSourceKey;
    const controller = new AbortController();
    // If the meta never arrives, the table does not hang: when the time runs out
    // it queries with the manually supplied limits; if the meta arrives later,
    // normalization still runs.
    const timeout = awaitsMeta ? setTimeout(() => settleMeta(key), metaTimeoutMs) : undefined;
    getMeta({ signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        // The limits and operators of a server that speaks a protocol we do not
        // support may not mean what we understand them to mean: the meta is
        // ignored and we continue with the manually supplied limits.
        if (!next.protocol.supported.includes(DATATABLEX_PROTOCOL_VERSION)) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[datatablex] The endpoint supports DataTableX protocol ${next.protocol.supported.join(", ")}, the client speaks ${DATATABLEX_PROTOCOL_VERSION}. ` +
                "The meta was ignored; upgrade the packages to the same protocol version.",
            );
          }
          if (awaitsMeta) settleMeta(key);
          return;
        }
        // The wait ends in the SAME step as normalization (the effect below); if
        // it ended earlier, a non-normalized query would slip through once.
        setMetaEntry({ key, meta: next });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (awaitsMeta) settleMeta(key);
        if (process.env.NODE_ENV !== "production") {
          console.warn("[datatablex] The endpoint meta could not be read; continuing with the manually supplied limits.", err);
        }
      });
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [dataSourceRef, dataSourceKey, awaitsMeta, metaTimeoutMs, settleMeta]);

  const serverOptions = typeof dataSource.getOptions === "function";
  const narrowed = useMemo(() => (meta ? applyEndpointMeta(columns, meta, serverOptions) : null), [columns, meta, serverOptions]);

  // --- Enum options coming from the server ---
  // Like the meta, the state is stored with the `dataSourceKey` it belongs to: when
  // the key changes, the options of the old source are not applied and are
  // requested again. If the source stays the same while the user or role changes,
  // `invalidateMeta()` plus a new `dataSourceKey` is needed.
  const [optionsEntry, setOptionsEntry] = useState<{ key: string | number | undefined; byField: Record<string, FieldOptionsEntry> }>({ key: dataSourceKey, byField: NO_FIELD_OPTIONS });
  const fieldOptions = optionsEntry.key === dataSourceKey ? optionsEntry.byField : NO_FIELD_OPTIONS;
  /** The fields whose options are expected from the server (columns that carry `optionsState`). */
  const optionFields = useMemo(() => {
    const fields = new Set<string>();
    for (const column of narrowed?.columns ?? []) {
      const field = columnField(column);
      if (column.optionsState !== undefined && field !== null) fields.add(field);
    }
    return fields;
  }, [narrowed]);
  const optionFieldsRef = useRef(optionFields);
  useIsomorphicLayoutEffect(() => {
    optionFieldsRef.current = optionFields;
  }, [optionFields]);
  /** Running and completed requests; aborted and renewed when `dataSourceKey` changes or on unmount. */
  const optionRequestsRef = useRef<{ key: string | number | undefined; controller: AbortController; fields: Set<string> } | null>(null);
  useEffect(
    () => () => {
      optionRequestsRef.current?.controller.abort();
      optionRequestsRef.current = null;
      // An aborted request never settles: a field left in "loading" (including when
      // StrictMode re-runs the effects) could never be requested again.
      setOptionsEntry((prev) => {
        const settled = Object.entries(prev.byField).filter(([, entry]) => entry.status !== "loading");
        return settled.length === Object.keys(prev.byField).length ? prev : { key: prev.key, byField: Object.fromEntries(settled) };
      });
    },
    [dataSourceKey],
  );
  const loadOptions = useCallback(
    (field: string) => {
      const getOptions = dataSourceRef.current.getOptions?.bind(dataSourceRef.current);
      if (!getOptions || !optionFieldsRef.current.has(field)) return;
      const key = dataSourceKey;
      let requests = optionRequestsRef.current;
      if (!requests || requests.key !== key || requests.controller.signal.aborted) {
        requests?.controller.abort();
        requests = { key, controller: new AbortController(), fields: new Set() };
        optionRequestsRef.current = requests;
      }
      if (requests.fields.has(field)) return;
      requests.fields.add(field);
      const { controller, fields } = requests;
      const settle = (entry: FieldOptionsEntry) => {
        if (controller.signal.aborted) return;
        setOptionsEntry((prev) => ({ key, byField: { ...(prev.key === key ? prev.byField : null), [field]: entry } }));
      };
      settle({ status: "loading" });
      getOptions(field, { signal: controller.signal }).then(
        (options) => settle({ status: "ready", options }),
        (err: unknown) => {
          if (controller.signal.aborted) return;
          // An error is not cached: the next `loadOptions(field)` tries again.
          fields.delete(field);
          settle({ status: "error" });
          if (process.env.NODE_ENV !== "production") {
            console.warn(`[datatablex] The options of field "${field}" could not be read; the filter of the column was disabled.`, err);
          }
        },
      );
    },
    [dataSourceRef, dataSourceKey],
  );
  const effectiveColumns = useMemo(() => {
    const base = narrowed?.columns ?? columns;
    if (!optionFields.size) return base;
    return base.map((column) => {
      const field = columnField(column);
      const entry = column.optionsState !== undefined && field !== null ? fieldOptions[field] : undefined;
      if (!entry) return column;
      if (entry.status === "loading") return { ...column, optionsState: entry.status };
      // An empty list and an error disable only this column's filter; the rules on the column are kept as outer nodes.
      const options = entry.status === "ready" ? (entry.options ?? []) : [];
      return { ...column, optionsState: entry.status, options, ...(options.length ? null : { filterable: false }) };
    });
  }, [narrowed, columns, optionFields, fieldOptions]);
  const maxSearchLength = meta ? Math.min(configuredMaxSearchLength, meta.limits.maxSearchLength) : configuredMaxSearchLength;
  // In the filter limits, `null` means "no meta — the consumer applies its own default".
  const limits = useMemo<TableLimits>(
    () => ({
      maxSearchLength,
      maxFilterCount: meta?.limits.maxFilterCount ?? null,
      maxFilterDepth: meta?.limits.maxFilterDepth ?? null,
      maxInValues: meta?.limits.maxInValues ?? null,
    }),
    [maxSearchLength, meta],
  );

  useEffect(() => {
    if (process.env.NODE_ENV === "production" || !meta) return;
    if (narrowed?.disabled.length) {
      console.warn(
        `[datatablex] The endpoint meta disabled filtering/sorting on these columns: ${narrowed.disabled.join(", ")}. ` +
          "Align the column definitions with the backend `fields` whitelist.",
      );
    }
    if (typeof rowKey === "string" && rowKey !== meta.primaryKey) {
      console.warn(
        `[datatablex] rowKey "${rowKey}" is not the same as the backend primaryKey "${meta.primaryKey}" — exporting selected rows may fetch the wrong rows.`,
      );
    }
  }, [meta, narrowed, rowKey]);

  // --- URL synchronization ---
  // The adapter, the options and the current query are carried in refs so that the
  // subscription and the writes are not re-created on every render (the same
  // principle as for `dataSource`).
  const urlAdapter = useMemo<UrlStateAdapter | null>(
    () => (syncWithUrl === true ? createHistoryAdapter() : syncWithUrl || null),
    [syncWithUrl],
  );
  const sortableFields = useMemo(
    // The URL and `NORMALIZE_QUERY` validate sorting by BACKEND FIELD.
    () => new Set(effectiveColumns.flatMap((c) => (c.sortable && columnField(c) !== null ? [columnField(c) as string] : []))),
    [effectiveColumns],
  );
  const urlOptions = useMemo<UrlStateOptions>(
    () => ({
      prefix: urlParamPrefix,
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: meta?.limits.maxPageSize,
      maxSearchLength,
      sortableFields,
    }),
    [urlParamPrefix, meta, maxSearchLength, sortableFields],
  );
  const queryState = useMemo<UrlQueryState>(
    () => ({ page: state.page, pageSize: state.pageSize, sorting: state.sorting, search: state.search, filters: state.filters }),
    [state.page, state.pageSize, state.sorting, state.search, state.filters],
  );
  const urlAdapterRef = useRef(urlAdapter);
  const urlOptionsRef = useRef(urlOptions);
  const queryStateRef = useRef(queryState);
  useIsomorphicLayoutEffect(() => {
    urlAdapterRef.current = urlAdapter;
    urlOptionsRef.current = urlOptions;
    queryStateRef.current = queryState;
  }, [urlAdapter, urlOptions, queryState]);

  // The first query is not sent before the URL is read; otherwise the default
  // query would go first, wrong data would flash on a shared link and a request
  // would be wasted. The read happens BEFORE paint; the initial state is not built
  // from the URL, because for a consumer that renders on the server the first
  // render must be the same on both sides (the same rule as for column state).
  const urlEnabled = urlAdapter !== null;
  const [urlHydrated, setUrlHydrated] = useState(!urlEnabled);
  // The URL of the new adapter is also read when the adapter CHANGES (a router
  // adapter that is re-created when the route or tenant changes); otherwise the
  // table would stay out of step with the new URL until the first user
  // interaction. If the URL is the same as the table state, nothing is
  // dispatched, so an adapter passed as a new object on every render does not
  // cause a loop. The running request of the old adapter is aborted in the cleanup
  // of the fetch effect because the state changed.
  useIsomorphicLayoutEffect(() => {
    if (!urlAdapter) {
      setUrlHydrated(true);
      return;
    }
    const fromUrl = readUrlState(urlAdapter.get(), urlOptionsRef.current);
    if (!urlStateEqual(fromUrl, queryStateRef.current)) dispatch({ type: "APPLY_URL_STATE", ...fromUrl });
    setUrlHydrated(true);
  }, [urlAdapter, urlParamPrefix]);

  // When the meta arrives or changes, the current query is pulled into the new
  // bounds. The first query does NOT wait for the meta by default; if a query sent
  // before the meta got a 400 because of a field that can no longer be sorted or a
  // search that is too long, the normalization here changes the state and the
  // re-query clears the error by itself.
  useEffect(() => {
    if (!meta) return;
    dispatch({ type: "NORMALIZE_QUERY", limits: { maxPageSize: meta.limits.maxPageSize, maxSearchLength, sortableFields } });
    // `awaitMeta`: the wait that ends in the same effect is rendered together with
    // the normalized state, so the first query is a single, canonical one.
    if (awaitsMeta) settleMeta(dataSourceKey);
  }, [meta, maxSearchLength, sortableFields, awaitsMeta, settleMeta, dataSourceKey, dispatch]);

  // The options of a column with an active rule are requested as soon as the meta
  // arrives (for example a filter coming from the URL); otherwise chip labels would
  // show the raw value until the editor is opened. For other columns the request
  // is sent when the editor is opened.
  useEffect(() => {
    if (!optionFields.size) return;
    for (const field of filterFields(state.filters)) {
      if (optionFields.has(field) && fieldOptions[field] === undefined) loadOptions(field);
    }
  }, [optionFields, fieldOptions, state.filters, loadOptions]);

  // Query -> URL. Echo suppression: if the state in the URL is logically the same
  // (`filtersEqual` for filters), nothing is written. Only a page change made by
  // the user creates a history entry (`push`); search, filter, sorting, page size
  // and the correction of an out-of-range page are written with `replace`.
  const pushNextUrlRef = useRef(false);
  const urlLengthWarnedRef = useRef(false);
  useEffect(() => {
    const adapter = urlAdapterRef.current;
    const push = pushNextUrlRef.current;
    pushNextUrlRef.current = false;
    if (!adapter || !urlHydrated) return;
    const current = adapter.get();
    const opts = urlOptionsRef.current;
    // Equality is established on the RAW content of the URL (without applying
    // bounds or the whitelist). A normalized read would count stale values, such as
    // a `sort=age` that the meta later disabled or a search that was truncated, as
    // "already equal" and would never correct the URL. For the same reason, a link
    // that carries an invalid value is cleaned with `replace` after the first
    // query.
    const fromUrl = readUrlState(current, { prefix: opts.prefix, defaultPageSize: opts.defaultPageSize });
    if (urlStateEqual(fromUrl, queryState)) return;
    const onlyPageChanged = fromUrl.page !== queryState.page && urlStateEqual({ ...fromUrl, page: queryState.page }, queryState);
    const next = writeUrlState(current, queryState, opts);
    adapter.set(next, { replace: !(push && onlyPageChanged) });
    if (process.env.NODE_ENV !== "production" && !urlLengthWarnedRef.current && next.toString().length > 2000) {
      urlLengthWarnedRef.current = true;
      console.warn(
        "[datatablex] The URL query exceeded 2 KB; some proxies and CDNs reject long URLs. Consider reducing the number of filters (the URL is not pruned).",
      );
    }
  }, [urlHydrated, queryState]);

  // URL -> query (back/forward button, router navigation). If the state is the
  // same, nothing is done; otherwise it is applied in a single step and the effect
  // above sees the equality and does not write back to the URL.
  const missingSubscribeWarnedRef = useRef(false);
  useEffect(() => {
    if (!urlAdapter) return;
    if (!urlAdapter.subscribe) {
      if (process.env.NODE_ENV !== "production" && syncWithUrl !== true && !missingSubscribeWarnedRef.current) {
        missingSubscribeWarnedRef.current = true;
        console.warn(
          "[datatablex] The `syncWithUrl` adapter does not provide `subscribe`; the browser back/forward button changes the URL but does not change the table.",
        );
      }
      return;
    }
    return urlAdapter.subscribe(() => {
      const fromUrl = readUrlState(urlAdapter.get(), urlOptionsRef.current);
      if (urlStateEqual(fromUrl, queryStateRef.current)) return;
      dispatch({ type: "APPLY_URL_STATE", ...fromUrl });
    });
  }, [urlAdapter, syncWithUrl, dispatch]);

  // Only the request with the LATEST sequence number updates data/loading, which
  // prevents a stale response from overwriting a newer state.
  const sequenceRef = useRef(0);
  const pendingReloadsRef = useRef<PendingReload[]>([]);

  // Pending reloads are rejected explicitly on unmount; otherwise
  // `await table.reload()` would hang forever. Thanks to the empty dependency
  // array, this cleanup runs ONLY on unmount; on intermediate dependency changes
  // the next fetch settles the pending ones anyway.
  useEffect(
    () => () => {
      const pending = pendingReloadsRef.current;
      pendingReloadsRef.current = [];
      pending.forEach((p) =>
        p.reject(new Error("[datatablex] The component was unmounted before reload() completed.")),
      );
    },
    [],
  );

  useEffect(() => {
    if (!urlHydrated || !metaSettled) return;
    const seq = ++sequenceRef.current;
    const controller = new AbortController();
    const requested = requestSnapshot({ page: state.page, pageSize: state.pageSize, sorting: state.sorting, filters: state.filters, search: state.search, reloadToken: state.reloadToken });
    dispatch({ type: "FETCH_START" });

    const query: DataTableQuery = {
      pagination: { page: state.page, pageSize: state.pageSize },
      sorting: state.sorting,
      filters: andFilterGroups(lockedFilters, state.filters),
      search: state.search.trim() ? state.search.trim() : undefined,
    };

    dataSourceRef.current
      .fetch(query, { signal: controller.signal })
      .then((result) => {
        if (seq !== sequenceRef.current || !isSameRequest(latestStateRef.current, requested)) return;

        dispatch({
          type: "FETCH_SUCCESS",
          data: result.data,
          total: result.pagination.total,
          page: result.pagination.page,
          pageSize: result.pagination.pageSize,
        });

        // Out-of-range page: it is pulled to ceil(total/pageSize) using total and
        // fetched once more. The formula in the contract also returns 1 for
        // `total === 0` (`Math.max(1, Math.ceil(0 / pageSize))`); if this branch
        // were skipped under a `total > 0` condition, a table whose result becomes
        // empty would be left in an inconsistent pagination state such as
        // "page 2 / 0 records".
        const total = result.pagination.total;
        if (total !== null) {
          const maxPage = Math.max(1, Math.ceil(total / result.pagination.pageSize));
          if (result.pagination.page > maxPage) {
            dispatch({ type: "CORRECT_PAGE", page: maxPage });
          }
        }

        const pending = pendingReloadsRef.current;
        pendingReloadsRef.current = [];
        pending.forEach((p) => p.resolve());
      })
      .catch((err: unknown) => {
        if (seq !== sequenceRef.current || !isSameRequest(latestStateRef.current, requested)) return;
        if (err instanceof DOMException && err.name === "AbortError") return; // a newer request took its place — not an error

        const error = err instanceof Error ? err : new Error(String(err));
        dispatch({ type: "FETCH_ERROR", error });

        const pending = pendingReloadsRef.current;
        pendingReloadsRef.current = [];
        pending.forEach((p) => p.reject(error));
      });

    return () => controller.abort();
  }, [
    dataSourceRef,
    dataSourceKey,
    state.page,
    state.pageSize,
    state.sorting,
    state.filters,
    lockedFilters,
    state.search,
    state.reloadToken,
    urlHydrated,
    metaSettled,
    dispatch,
  ]);

  const setSorting = useCallback((sorting: Sort[]) => dispatch({ type: "SET_SORTING", sorting }), [dispatch]);
  const setFilters = useCallback((filters: FilterGroup | null) => dispatch({ type: "SET_FILTERS", filters }), [dispatch]);
  // Programmatic calls (a search box outside the table, the URL) are subject to the
  // same ceiling too; a term longer than the backend `maxSearchLength` would get a
  // 400.
  const setSearch = useCallback(
    (search: string) => dispatch({ type: "SET_SEARCH", search: search.slice(0, maxSearchLength) }),
    [dispatch, maxSearchLength],
  );
  const setSelectedRowKeys = useCallback((keys: Key[]) => dispatch({ type: "SET_SELECTED_ROW_KEYS", keys }), [dispatch]);
  const reset = useCallback(() => dispatch({ type: "RESET" }), [dispatch]);

  const cancelExport = useCallback(() => exportAbortRef.current?.abort(), []);

  const exportData = useCallback(
    async (
      format: ExportFormat,
      scope: ExportScope = "allFiltered",
      exportOptions?: { filename?: string; title?: string },
    ): Promise<ExportOutcome> => {
      if (exportInFlightRef.current) return "cancelled";
      // While a new query is loading, `state.data` is the result of the PREVIOUS
      // query; the file would not match the filter on screen.
      if (scope === "currentPage" && state.loading) {
        throw new DataTableExportError("export_table_loading", "[datatablex] The current page cannot be exported while the table is loading; try again when loading finishes.");
      }
      const title = exportOptions?.title ?? DEFAULT_EXPORT_TITLE;
      const filename = exportOptions?.filename ?? `${tableId ?? "export"}-${new Date().toISOString().slice(0, 10)}.${EXPORT_EXTENSION[format]}`;
      const exportColumns = exportColumnsFor(columns, columnState);
      const primaryKey = typeof rowKey === "string" ? rowKey : null;
      if (!exportColumns.length) throw new DataTableExportError("export_no_columns", "[datatablex] There is no visible column to export.");

      // An empty selection throws but does NOT change the export state at all, so the
      // user cannot create a race condition with a second click.
      if (scope === "selected" && state.selectedRowKeys.length === 0) {
        throw new DataTableExportError("no_rows_selected", "[datatablex] No row is selected.");
      }
      if (scope === "selected" && !primaryKey) {
        throw new DataTableExportError("export_selection_key", "[datatablex] For a `selected` export, rowKey must be the string name of the backend primaryKey field.");
      }
      if (scope === "selected" && exportSelectionBlocked) {
        throw new DataTableExportError(
          "export_selection_key",
          `[datatablex] rowKey "${String(rowKey)}" is not the same as the backend primaryKey "${meta?.primaryKey}" — exporting selected rows could fetch the wrong rows, so no request was sent. Make rowKey the same as primaryKey.`,
        );
      }

      const source = dataSourceRef.current;
      const serverLimit = source.requestExport ? serverExportLimits(meta)?.[format] : undefined;
      const exporter: DocumentExporter | undefined =
        serverLimit !== undefined || format === "csv" ? undefined : exportersRef.current?.find((candidate) => candidate.format === format);
      if (serverLimit === undefined && format !== "csv" && !exporter) {
        throw new Error(
          `[datatablex] No adapter is registered for "${format}" export and the server does not produce this format: pass \`import { ${format}Exporter } from "@datatablex/react/${format}"\` and \`exporters: [${format}Exporter]\`, or add it to \`export.formats\` on the server.`,
        );
      }
      const serverColumns =
        serverLimit !== undefined ? serverExportColumnsFor(columns, columnState, meta?.export ? new Set(meta.export.fields) : null) : null;
      if (serverColumns) {
        if (!serverColumns.columns.length) throw new DataTableExportError("export_no_columns", "[datatablex] There is no visible column that is open to server export.");
        if (serverColumns.skipped.length && process.env.NODE_ENV !== "production") {
          console.warn(
            `[datatablex] Server export does not include these columns: ${serverColumns.skipped.join(", ")} — they are computed (field: null / function accessor) or not in the export.fields of the endpoint.`,
          );
        }
      }
      const keys = scope === "selected" ? ([...new Set(state.selectedRowKeys)] as Array<string | number>) : [];

      // The ceiling is checked against the known total before any request is sent (the server still decides with its own COUNT).
      const limit = serverLimit ?? clientExportLimit(maxClientExportRows, format);
      const knownTotal = scope === "selected" ? keys.length : scope === "allFiltered" ? state.total : serverLimit !== undefined ? state.data.length : null;
      if (limit !== null && knownTotal !== null && knownTotal > limit) {
        throw new ExportRowLimitError(knownTotal, limit, serverLimit !== undefined ? "server" : "client", format);
      }

      exportInFlightRef.current = true;
      setIsExporting(true);
      const controller = new AbortController();
      exportAbortRef.current = controller;
      const { signal } = controller;
      // Even with a DataSource that ignores the signal, the loop stops between pages.
      const throwIfCancelled = () => {
        if (signal.aborted) throw new DOMException("Export was aborted.", "AbortError");
      };
      try {
        if (serverColumns) {
          // Server path: a ticket is obtained and the browser downloads the file
          // itself; the rows never enter JavaScript or memory. From here on,
          // progress and cancellation belong to the browser's download UI.
          let download;
          try {
            download = await source.requestExport!(
              {
                query: {
                  sorting: state.sorting,
                  // `selected` works only with the selected keys; the server ignores filter and search.
                  filters: scope === "selected" ? null : andFilterGroups(lockedFilters, state.filters),
                  search: scope === "selected" ? undefined : state.search.trim() || undefined,
                  ...(scope === "currentPage" ? { pagination: { page: state.page, pageSize: state.pageSize } } : null),
                },
                format,
                scope,
                ...(scope === "selected" ? { keys } : null),
                columns: serverColumns.columns,
                filename,
                title,
              },
              { signal },
            );
          } catch (cause) {
            if (cause instanceof DataTableRequestError && cause.status === 413) {
              const body = cause.body as { total?: unknown; maxRows?: unknown } | null;
              throw new ExportRowLimitError(Number(body?.total) || 0, Number(body?.maxRows) || 0, "server");
            }
            if (cause instanceof DataTableRequestError && cause.status === 429) {
              const body = cause.body as { maxConcurrent?: unknown } | null;
              throw new ExportBusyError(Number(body?.maxConcurrent) || null);
            }
            throw cause;
          }
          throwIfCancelled();
          startDownload(download.downloadUrl, download.filename);
          return "started";
        }

        // Client path: a source without server export (`createLocalDataSource`, or a
        // server that does not declare tickets). The rows are collected in memory.
        const rows: T[] = [];
        const appendRows = (next: T[]) => {
          throwIfCancelled();
          rows.push(...next);
        };

        if (scope === "currentPage") {
          setExportProgress({ current: state.data.length, total: state.data.length });
          appendRows(state.data);
        } else if (scope === "selected") {
          // The effective pageSize of the last normal response is the only indication
          // visible to the client of the backend maxPageSize. `exportChunkSize` is
          // only an upper bound to be aligned with maxInValues; the selected export
          // works with `in`, and a chunk that exceeds the backend `maxInValues` gets a
          // 400.
          const configuredChunkSize = Number.isSafeInteger(exportChunkSize) && exportChunkSize > 0 ? exportChunkSize : DEFAULT_EXPORT_CHUNK_SIZE;
          const requestedChunkSize = meta ? Math.min(configuredChunkSize, meta.limits.maxInValues) : configuredChunkSize;
          const chunkSize = Math.min(requestedChunkSize, state.pageSize);
          let fetchedCount = 0;
          setExportProgress({ current: 0, total: keys.length });
          for (let start = 0; start < keys.length; start += chunkSize) {
            const chunk = keys.slice(start, start + chunkSize);
            const result = await dataSourceRef.current.fetch(
              {
                pagination: { page: 1, pageSize: chunk.length },
                sorting: state.sorting,
                filters: { operator: "AND", filters: [{ field: primaryKey!, operator: "in", value: chunk }] },
                skipCount: true,
              },
              { signal },
            );
            // If an incomplete chunk comes back because of permissions, scope or a
            // backend ceiling, we stop explicitly instead of producing an incomplete
            // file.
            if (result.data.length !== chunk.length) {
              throw new DataTableExportError("export_incomplete", "[datatablex] The export query for the selected rows did not return all the rows; no file was created.");
            }
            appendRows(result.data);
            fetchedCount += result.data.length;
            setExportProgress({ current: fetchedCount, total: keys.length });
          }
        } else {
          const configuredChunkSize = Number.isSafeInteger(exportChunkSize) && exportChunkSize > 0 ? exportChunkSize : DEFAULT_EXPORT_CHUNK_SIZE;
          const makeQuery = (page: number, pageSize: number, skipCount?: boolean): DataTableQuery => ({
            pagination: { page, pageSize },
            sorting: state.sorting,
            filters: andFilterGroups(lockedFilters, state.filters),
            search: state.search.trim() || undefined,
            ...(skipCount ? { skipCount: true } : null),
          });
          const first = await dataSourceRef.current.fetch(makeQuery(1, configuredChunkSize), { signal });
          const total = first.pagination.total;
          if (total === null) throw new DataTableExportError("export_incomplete", "[datatablex] The export could not verify the total number of rows.");
          if (limit !== null && total > limit) throw new ExportRowLimitError(total, limit, "client", format);

          let fetchedCount = first.data.length;
          appendRows(first.data);
          setExportProgress({ current: fetchedCount, total });
          for (let page = 2; fetchedCount < total; page++) {
            const result = await dataSourceRef.current.fetch(makeQuery(page, first.pagination.pageSize, true), { signal });
            if (result.data.length === 0) {
              throw new DataTableExportError("export_incomplete", "[datatablex] The export query returned fewer rows than expected; no file was created.");
            }
            const pageRows = result.data.slice(0, total - fetchedCount);
            appendRows(pageRows);
            fetchedCount += pageRows.length;
            setExportProgress({ current: fetchedCount, total });
          }
        }
        throwIfCancelled();
        await downloadExport(format, exportColumns, rows, filename, exporter ? { exporter, title } : null);
        return "started";
      } catch (cause) {
        // The user or an unmount aborted it: not an error, a silent result.
        if (signal.aborted) return "cancelled";
        throw cause;
      } finally {
        if (exportAbortRef.current === controller) exportAbortRef.current = null;
        exportInFlightRef.current = false;
        setIsExporting(false);
        setExportProgress(null);
      }
    },
    [
      columnState,
      columns,
      dataSourceRef,
      exportChunkSize,
      exportSelectionBlocked,
      lockedFilters,
      maxClientExportRows,
      meta,
      rowKey,
      state.data,
      state.filters,
      state.loading,
      state.page,
      state.pageSize,
      state.search,
      state.selectedRowKeys,
      state.sorting,
      state.total,
      tableId,
    ],
  );

  const reload = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      pendingReloadsRef.current.push({ resolve, reject });
      dispatch({ type: "RELOAD" });
    });
  }, [dispatch]);

  const pagination = useMemo(
    () => ({
      current: state.page,
      pageSize: state.pageSize,
      total: state.total,
      onChange: (page: number, pageSize: number) => {
        // A page change made by the user is written to the URL with `push`; the back button returns to the previous page.
        pushNextUrlRef.current = true;
        dispatch({ type: "SET_PAGE", page, pageSize });
      },
    }),
    [dispatch, state.page, state.pageSize, state.total],
  );

  /**
   * Memoization is part of the contract: because `TableInstance` is designed to be
   * used from OUTSIDE the table, a new object on every render would send a consumer
   * that writes `useEffect(…, [table])` into an infinite loop and would defeat
   * `React.memo`'d child components.
   */
  return useMemo<TableInstance<T>>(
    () => ({
      data: state.data,
      loading: state.loading,
      error: state.error,
      pagination,
      sorting: state.sorting,
      setSorting,
      filters: state.filters,
      setFilters,
      lockedFilters,
      search: state.search,
      setSearch,
      selectedRowKeys: state.selectedRowKeys,
      setSelectedRowKeys,
      columnState,
      setColumnState,
      resetColumns,
      density,
      setDensity,
      headerDensity,
      setHeaderDensity,
      reload,
      reset,
      exportData,
      cancelExport,
      isExporting,
      exportProgress,
      exportFormats,
      exportSelectionBlocked,
      columns: effectiveColumns,
      rowKey,
      tableId,
      limits,
      // Present only if the source can provide options: a consumer (such as `<DataTable>`) reads that from its presence.
      loadOptions: serverOptions ? loadOptions : undefined,
      searchRevision: state.searchVersion,
    }),
    [
      state.data,
      state.loading,
      state.error,
      pagination,
      state.sorting,
      setSorting,
      state.filters,
      setFilters,
      lockedFilters,
      state.search,
      state.searchVersion,
      setSearch,
      state.selectedRowKeys,
      setSelectedRowKeys,
      columnState,
      setColumnState,
      resetColumns,
      density,
      setDensity,
      headerDensity,
      setHeaderDensity,
      reload,
      reset,
      exportData,
      cancelExport,
      isExporting,
      exportProgress,
      exportFormats,
      exportSelectionBlocked,
      rowKey,
      effectiveColumns,
      limits,
      loadOptions,
      serverOptions,
      tableId,
    ],
  );
}
