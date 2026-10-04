import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  Key,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  TouchEvent as ReactTouchEvent,
} from "react";
import { Alert, Button, Checkbox, ConfigProvider, Empty, Input, message, Pagination, Popover, Space, Table, Typography, theme } from "antd";
import type { TableProps } from "antd";
import type { ExportDefinition, Sort } from "@datatablex/core";
import type { ColumnState, ExportFormat, ExportScope, ReactDataTableColumn, TableInstance, UseDataTableOptions } from "@datatablex/react";
import type { DataTableProps, FilterBarOptions } from "./types.js";
import { ExportMenu } from "./ExportMenu.js";
import { ColumnsIcon } from "./icons.js";
import { FilterBar } from "./FilterBar.js";
import { ruleKindOf, ruleOperatorsFor } from "@datatablex/react/filter-model";
import { useDataTable } from "@datatablex/react";
import { resolveRowKey } from "./rowKey.js";
import { columnField, columnValue, dataTableErrorCode } from "@datatablex/core";
import { isDataTableRequestError, isExportBusyError, isExportRowLimitError } from "@datatablex/react";
import { ColumnHeaderMenu } from "./ColumnHeaderMenu.js";
import type { SortDirection } from "./ColumnHeaderMenu.js";
import { readSelectionColumnVisible, writeSelectionColumnVisible } from "./selectionColumn.js";
import { ROW_NUMBER_COLUMN_KEY, readRowNumberColumnVisible, writeRowNumberColumnVisible } from "./rowNumberColumn.js";
import { ANTD_SIZE_FOR_DENSITY, cellPadding } from "./density.js";
import { DataTableLocaleContext, enUS, useDataTableLocale } from "./locale.js";
import { columnLabel } from "./ruleEditor.js";
import type { DataTableLocale } from "./locale.js";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * The DEFAULT font of the Ant Design components inside the table. It is turned
 * off with `fontFamily={false}`; the `fontFamily` of the consumer's theme is
 * then inherited (see `DataTableProps.fontFamily`).
 */
const DATA_TABLE_FONT_FAMILY = '"Segoe UI", ui-sans-serif, system-ui, sans-serif';

/** A constant reference for instances without `table.exportFormats` (built by hand), so that hook dependencies do not change on every render. */
const CSV_ONLY_FORMATS: readonly ExportFormat[] = ["csv"];

const MIN_COLUMN_WIDTH = 40;
const ROW_NUMBER_COLUMN_WIDTH = 64;

interface ResizableTitleProps {
  width?: number;
  onResizeCommit?: (newWidth: number) => void;
  columnKey?: string;
  /** The plain-text name of the column, for the screen reader label (`columnKey` is meant for test ids). */
  columnLabel?: string;
  style?: CSSProperties;
  children?: ReactNode;
  [key: string]: unknown;
}

const KEYBOARD_RESIZE_STEP = 10;

/**
 * `components.header.cell` is a SINGLE component for all header cells; which
 * column is being resized is determined by the `onResizeCommit` passed through
 * `onHeaderCell` (see `antdColumns`). During a drag, local state shows a live
 * guide line; `table.setColumnState` (and therefore the localStorage write and
 * the re-render) is called only ONCE, when the drag/touch ENDS.
 *
 * The listeners added to `document` are removed both when the drag ends and on
 * unmount; otherwise the delayed end event of a component that was unmounted
 * in the middle of a drag would still trigger `onResizeCommit` (and therefore
 * the localStorage write).
 *
 * Mouse (`mousedown`/`mousemove`/`mouseup`) AND touch (`touchstart`/
 * `touchmove`/`touchend`) share the same `beginDrag` core; both attach their
 * listeners to `document` because a drag/touch can move outside the handle's
 * 8px area. The handle is also a focusable `role="separator"` that can be
 * resized in discrete steps with the arrow keys; a handle that works only with
 * a mouse and is not semantically accessible would exclude touch users and
 * keyboard-only users.
 */
function ResizableTitle({ width, onResizeCommit, columnKey, columnLabel, style, children, ...restProps }: ResizableTitleProps) {
  const thRef = useRef<HTMLTableCellElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const detachRef = useRef<(() => void) | null>(null);
  const [dragDeltaPx, setDragDeltaPx] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [tableHeight, setTableHeight] = useState<number | null>(null);
  const { token } = theme.useToken();
  const locale = useDataTableLocale();
  const hasHandle = onResizeCommit !== undefined;

  useEffect(() => () => detachRef.current?.(), []);

  // The handle can be grabbed along the WHOLE TABLE (rows included), not only in
  // the header cell: its height is the measured height of the `<table>` (header +
  // body), re-measured when data loads and the row count changes. Without a
  // measurement (0, or an environment without `ResizeObserver`) the handle
  // stays at the height of the cell.
  useIsomorphicLayoutEffect(() => {
    const table = hasHandle ? thRef.current?.closest("table") : null;
    if (!table) return;
    const measure = () => setTableHeight(table.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [hasHandle]);
  const handleHeight = tableHeight ? `${tableHeight}px` : "100%";

  /** Start of a drag/touch: `attach` sets up the listeners specific to the real event type (mouse/touch) and returns the function that removes them. */
  const beginDrag = useCallback(
    (clientX: number, attach: (onMove: (clientX: number) => void, onEnd: (clientX: number) => void) => () => void) => {
      startXRef.current = clientX;
      startWidthRef.current = width ?? thRef.current?.getBoundingClientRect().width ?? 0;
      setDragDeltaPx(0);

      const onMove = (nextClientX: number) => {
        const nextWidth = Math.max(MIN_COLUMN_WIDTH, startWidthRef.current + (nextClientX - startXRef.current));
        setDragDeltaPx(nextWidth - startWidthRef.current);
      };
      const onEnd = (nextClientX: number) => {
        detachRef.current?.();
        setDragDeltaPx(null);
        onResizeCommit?.(Math.max(MIN_COLUMN_WIDTH, startWidthRef.current + (nextClientX - startXRef.current)));
      };
      detachRef.current = attach(onMove, onEnd);
    },
    [width, onResizeCommit],
  );

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      beginDrag(e.clientX, (onMove, onEnd) => {
        const handleMouseMove = (moveEvent: MouseEvent) => {
          moveEvent.preventDefault();
          onMove(moveEvent.clientX);
        };
        const handleMouseUp = (upEvent: MouseEvent) => onEnd(upEvent.clientX);
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
        return () => {
          document.removeEventListener("mousemove", handleMouseMove);
          document.removeEventListener("mouseup", handleMouseUp);
          detachRef.current = null;
        };
      });
    },
    [beginDrag],
  );

  const handleTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      beginDrag(touch.clientX, (onMove, onEnd) => {
        const handleTouchMove = (moveEvent: TouchEvent) => {
          const moveTouch = moveEvent.touches[0];
          if (!moveTouch) return;
          moveEvent.preventDefault();
          onMove(moveTouch.clientX);
        };
        const handleTouchEnd = (endEvent: TouchEvent) => onEnd(endEvent.changedTouches[0]?.clientX ?? startXRef.current);
        // `passive: false`: `touchAction: "none"` only blocks native scrolling;
        // to reliably stop the page from scrolling during the drag,
        // `preventDefault()` must be callable.
        document.addEventListener("touchmove", handleTouchMove, { passive: false });
        document.addEventListener("touchend", handleTouchEnd);
        document.addEventListener("touchcancel", handleTouchEnd);
        return () => {
          document.removeEventListener("touchmove", handleTouchMove);
          document.removeEventListener("touchend", handleTouchEnd);
          document.removeEventListener("touchcancel", handleTouchEnd);
          detachRef.current = null;
        };
      });
    },
    [beginDrag],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!onResizeCommit) return;
      const current = width ?? thRef.current?.getBoundingClientRect().width ?? MIN_COLUMN_WIDTH;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onResizeCommit(Math.max(MIN_COLUMN_WIDTH, current - KEYBOARD_RESIZE_STEP));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onResizeCommit(current + KEYBOARD_RESIZE_STEP);
      }
    },
    [width, onResizeCommit],
  );

  if (!onResizeCommit) {
    return (
      <th {...restProps} style={style}>
        {children}
      </th>
    );
  }

  return (
    // `overflow: visible`: on `ellipsis` columns Ant Design sets the header cell
    // to `overflow: hidden`, which would clip the handle that extends below the
    // cell (clipping the header text is done by the `ColumnHeaderMenu` button).
    <th {...restProps} ref={thRef} style={{ ...style, position: "relative", overflow: "visible" }}>
      {children}
      <span
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        // On sortable columns Ant Design injects `onClick` into the `<th>` (through
        // `restProps`); since the handle is a child of that `<th>`, a click would
        // bubble up and also trigger sorting.
        onClick={(e) => e.stopPropagation()}
        role="separator"
        aria-orientation="vertical"
        aria-label={locale.resizeHandle(columnLabel ?? columnKey ?? "")}
        aria-valuenow={width !== undefined ? Math.round(width) : undefined}
        aria-valuemin={MIN_COLUMN_WIDTH}
        tabIndex={0}
        data-testid={`resize-handle-${columnKey ?? ""}`}
        // `zIndex`: fixed column cells carry `position: sticky` + a z-index in Ant Design;
        // the handle must stay above them so that it can also be grabbed in the rows.
        style={{ position: "absolute", right: 0, top: 0, height: handleHeight, width: 8, zIndex: 3, cursor: "col-resize", userSelect: "none", touchAction: "none" }}
      >
        {/* A thin line along the whole table on hover: shows that the handle exists and where it is. */}
        <span
          aria-hidden="true"
          data-testid={`resize-line-${columnKey ?? ""}`}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: 2,
            background: token.colorPrimaryBorder,
            opacity: hovered ? 1 : 0,
            transition: "opacity 0.15s",
            pointerEvents: "none",
          }}
        />
      </span>
      {dragDeltaPx !== null ? (
        <span
          data-testid={`resize-guide-${columnKey ?? ""}`}
          style={{
            position: "absolute",
            top: 0,
            height: handleHeight,
            right: 0,
            width: 2,
            zIndex: 3,
            background: token.colorPrimary,
            transform: `translateX(${dragDeltaPx}px)`,
            pointerEvents: "none",
          }}
        />
      ) : null}
    </th>
  );
}

/**
 * Controls for toggling, from the panel, the virtual columns that are not
 * defined in `columns` (the selection checkbox, the row number). They cannot be
 * reordered and do not count toward the "at least one visible column" rule.
 */
interface VirtualColumnControl {
  visible: boolean;
  onToggle: () => void;
  onReset: () => void;
}

/** The panel for showing, hiding and reordering columns; it appears in the toolbar when `columnManagement` is on. */
function ColumnManagementPanel<T>({
  table,
  selection,
  rowNumber,
}: {
  table: TableInstance<T>;
  selection?: VirtualColumnControl;
  rowNumber: VirtualColumnControl;
}) {
  const locale = useDataTableLocale();
  const titleByKey = useMemo(() => new Map(table.columns.map((c) => [c.key, c.title])), [table.columns]);
  const labelByKey = useMemo(() => new Map(table.columns.map((c) => [c.key, columnLabel(c)])), [table.columns]);
  const fixedByKey = useMemo(() => new Map(table.columns.map((c) => [c.key, c.fixed])), [table.columns]);
  const ordered = useMemo(() => [...table.columnState].sort((a, b) => a.order - b.order), [table.columnState]);
  const visibleCount = useMemo(() => ordered.filter((cs) => !cs.hidden).length, [ordered]);

  // In Ant Design, how a `fixed` column sticks depends on the column ORDER: if a
  // left-fixed column moved behind a normal column, the sticky layer and the
  // panel order would diverge. `left`, `right` and (normal) are therefore
  // counted as three separate regions; reordering is free only WITHIN the same
  // region.
  const partitionOf = (key: string): 0 | 1 | 2 => {
    const fixed = fixedByKey.get(key);
    return fixed === "left" ? 0 : fixed === "right" ? 2 : 1;
  };

  // The last visible column cannot be hidden: if all columns could be hidden,
  // the table would look empty although it actually holds data (there would be
  // NO understandable empty state for the user), and when `tableId` is given
  // that state would be persisted.
  const toggleHidden = (key: string) => {
    table.setColumnState(
      table.columnState.map((cs) => {
        if (cs.key !== key) return cs;
        if (!cs.hidden && visibleCount <= 1) return cs;
        return { ...cs, hidden: !cs.hidden };
      }),
    );
  };

  // Moves a visible column by jumping over its hidden neighbors; otherwise
  // moving past a hidden column would change `columnState.order` but produce NO
  // visual effect in the table. If a neighbor is in a different `fixed` region
  // (hidden or not), the search stops there: a target across the boundary counts
  // as NONE (`-1`), so a fixed column can never be moved out of its own region
  // (see the region partition above).
  const findVisibleNeighbor = (fromIndex: number, direction: -1 | 1): number => {
    const partition = partitionOf(ordered[fromIndex]!.key);
    let i = fromIndex + direction;
    while (i >= 0 && i < ordered.length) {
      if (partitionOf(ordered[i]!.key) !== partition) return -1;
      if (!ordered[i]!.hidden) return i;
      i += direction;
    }
    return -1;
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = findVisibleNeighbor(index, direction);
    if (target < 0) return;
    const reordered = [...ordered];
    const a = reordered[index]!;
    const b = reordered[target]!;
    reordered[index] = b;
    reordered[target] = a;
    table.setColumnState(reordered.map((cs, i) => ({ ...cs, order: i })));
  };

  return (
    <Space direction="vertical" style={{ minWidth: 220 }}>
      {/* Cannot be reordered and does not count toward the "at least one visible column" rule: it is not a data column. */}
      {selection ? (
        <Checkbox checked={selection.visible} onChange={selection.onToggle}>
          {locale.selectionColumn}
        </Checkbox>
      ) : null}
      <Checkbox checked={rowNumber.visible} onChange={rowNumber.onToggle}>
        {locale.rowNumberColumn}
      </Checkbox>
      {ordered.map((cs, index) => {
        const canMoveUp = findVisibleNeighbor(index, -1) >= 0;
        const canMoveDown = findVisibleNeighbor(index, 1) >= 0;
        const isLastVisible = !cs.hidden && visibleCount <= 1;
        return (
          <Space key={cs.key} style={{ width: "100%", justifyContent: "space-between" }}>
            <Checkbox checked={!cs.hidden} disabled={isLastVisible} onChange={() => toggleHidden(cs.key)}>
              {titleByKey.get(cs.key) ?? cs.key}
            </Checkbox>
            <Space size={4}>
              <Button size="small" disabled={!canMoveUp} onClick={() => move(index, -1)} aria-label={locale.moveUp(labelByKey.get(cs.key) ?? cs.key)}>
                ↑
              </Button>
              <Button size="small" disabled={!canMoveDown} onClick={() => move(index, 1)} aria-label={locale.moveDown(labelByKey.get(cs.key) ?? cs.key)}>
                ↓
              </Button>
            </Space>
          </Space>
        );
      })}
      <Button
        size="small"
        block
        onClick={() => {
          table.resetColumns();
          selection?.onReset();
          rowNumber.onReset();
        }}
      >
        {locale.resetView}
      </Button>
    </Space>
  );
}

function sortOrderFor(field: string, sorting: Sort[]): "ascend" | "descend" | undefined {
  const found = sorting.find((s) => s.field === field);
  if (!found) return undefined;
  return found.direction === "asc" ? "ascend" : "descend";
}


const SEARCH_DEBOUNCE_MS = 300;
/** The same as the backend defaults for `maxFilterCount`/`maxInValues`; used when the meta cannot be read. */
const DEFAULT_MAX_FILTER_COUNT = 50;
const DEFAULT_MAX_FILTER_DEPTH = 3;
const DEFAULT_MAX_IN_VALUES = 500;

interface DebouncedCallback {
  run: (value: string) => void;
  cancel: () => void;
}

/**
 * `fnRef` is updated in an effect, NOT during the render phase: mutating a ref
 * during render is unsafe under concurrent rendering and StrictMode. `cancel`
 * is needed both for the cleanup on unmount and for syncing the search box from
 * the outside.
 */
function useDebouncedCallback(fn: (value: string) => void, delay: number): DebouncedCallback {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const cancel = useCallback(() => {
    if (timeoutRef.current !== undefined) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const run = useCallback(
    (value: string) => {
      cancel();
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = undefined;
        fnRef.current(value);
      }, delay);
    },
    [cancel, delay],
  );

  return useMemo(() => ({ run, cancel }), [run, cancel]);
}

interface CommonProps {
  searchable?: boolean;
  selectable?: boolean;
  columnManagement?: boolean;
  export?: ExportDefinition;
  empty?: ReactNode;
  errorRender?: (error: Error, retry: () => Promise<void>) => ReactNode;
  fontFamily?: string | false;
  locale?: Partial<DataTableLocale>;
  filterBar?: boolean | FilterBarOptions;
}

/**
 * If a coded error has a counterpart in the locale, that text is used; otherwise
 * (a backend without codes, a new code) the error's own message is used.
 * For `validation`, the generic text does not say WHAT the problem is, so the
 * server's message (in the server's language, e.g. "at most one sensitive
 * filter") is added as `detail`.
 */
function errorText(error: Error, locale: DataTableLocale): { text: string; detail?: string } {
  const code = dataTableErrorCode(error);
  const localized = code && locale.errorMessages[code];
  if (!localized) return { text: error.message };
  if (code === "validation" && error.message && error.message !== localized) return { text: localized, detail: locale.errorDetail(error.message) };
  return { text: localized };
}

function ErrorDescription({ text, detail }: { text: string; detail?: string }) {
  if (!detail) return <>{text}</>;
  return (
    <>
      {text}
      <div style={{ fontSize: 12, opacity: 0.85 }}>{detail}</div>
    </>
  );
}

/**
 * The default error view. It is drawn ABOVE the table, not IN PLACE of it:
 * replacing the table would remove the toolbar and the column headers with it,
 * and since "retry" would resend the same failing query, every client-caused
 * 400 (a search of 200+ characters, an operator that is not on the allowlist)
 * would lock the user on a screen they cannot recover from.
 *
 * On a 4xx the retry action is not shown, because the same query gives the same
 * result; the action that clears the query (filters/search/sorting) is
 * emphasized instead. The selection and the column view are preserved.
 */
function DefaultErrorAlert<T>({ table, error }: { table: TableInstance<T>; error: Error }) {
  const locale = useDataTableLocale();
  const isClientError = isDataTableRequestError(error) && error.status >= 400 && error.status < 500;
  const hasQuery = Boolean(table.filters) || table.search !== "" || table.sorting.length > 0;
  const clearQuery = () => {
    table.setFilters(null);
    table.setSearch("");
    table.setSorting([]);
  };
  return (
    <Alert
      type="error"
      showIcon
      message={locale.errorTitle}
      description={<ErrorDescription {...errorText(error, locale)} />}
      action={
        <Space direction="vertical" size={4}>
          {!isClientError ? (
            // reload() can be rejected on unmount; if it is not caught it becomes an unhandled rejection.
            <Button size="small" type="primary" onClick={() => void table.reload().catch(() => {})}>
              {locale.retry}
            </Button>
          ) : null}
          {hasQuery ? (
            <Button size="small" type={isClientError ? "primary" : "default"} onClick={clearQuery}>
              {locale.clearQuery}
            </Button>
          ) : null}
        </Space>
      }
    />
  );
}

/** The `table` prop already comes from `useDataTable`, so no hook is called conditionally here. */
function DataTableInner<T>({
  table,
  searchable,
  selectable,
  columnManagement,
  export: requestedExport,
  empty,
  errorRender,
  fontFamily = DATA_TABLE_FONT_FAMILY,
  locale: localeOverrides,
  filterBar,
}: { table: TableInstance<T> } & CommonProps) {
  // A partial override is merged over the default (`enUS`), so no key is left without text.
  const locale = useMemo<DataTableLocale>(() => ({ ...enUS, ...localeOverrides }), [localeOverrides]);

  // The menu offers only the formats that are available: CSV, the adapters
  // registered through `exporters`, and the formats the server produces through
  // the ticket route (once the meta arrives). Because the server formats come
  // with the meta, the warning is given after the first load finishes; a format
  // that is neither registered nor produced by the server triggers a warning
  // once, in development mode.
  const exportFormats = table.exportFormats ?? CSV_ONLY_FORMATS;
  const exportDefinition = useMemo(() => {
    if (!requestedExport) return undefined;
    return { ...requestedExport, formats: requestedExport.formats.filter((format) => exportFormats.includes(format)) };
  }, [requestedExport, exportFormats]);
  const missingExporterWarnedRef = useRef(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || missingExporterWarnedRef.current || !requestedExport || table.loading) return;
    const missing = requestedExport.formats.filter((format) => !exportFormats.includes(format));
    if (!missing.length) return;
    missingExporterWarnedRef.current = true;
    console.warn(
      `[datatablex] export.formats asks for these formats, but no adapter is registered for them and the server does not produce them: ${missing.join(", ")}. ` +
        missing.map((format) => `\`import { ${format}Exporter } from "@datatablex/react/${format}"\``).join(", ") +
        " and pass them in `exporters={[...]}`, or add the formats to `export.formats` on the server; they are not shown in the menu.",
    );
  }, [requestedExport, exportFormats, table.loading]);
  const [searchInput, setSearchInput] = useState(table.search);
  const { token } = theme.useToken();
  const [messageApi, messageContextHolder] = message.useMessage();

  // The value that WILL BE or HAS BEEN pushed to the table. It does NOT wait for
  // the debounce timer to fire; it is updated immediately on every keystroke
  // (see the onChange below). If `table.search` differs from it, the change came
  // from outside (reset(), a programmatic setSearch, a "clear filters" button
  // outside the table) and the input must be synced.
  const intendedSearchRef = useRef(table.search);
  const pushSearch = useCallback(
    (value: string) => {
      intendedSearchRef.current = value;
      table.setSearch(value);
    },
    [table],
  );
  const debouncedSetSearch = useDebouncedCallback(pushSearch, SEARCH_DEBOUNCE_MS);

  // BOTH triggers are needed:
  //  - `table.searchRevision`: a `reset()` called inside the debounce WINDOW
  //    (while `table.search` is still `""`) targets `""` as well, so it produces
  //    no change in the VALUE; React's Object.is comparison would never re-run
  //    the effect, and the pending keystroke would silently undo the reset. The
  //    counter catches this because it increases on every search request,
  //    INDEPENDENTLY of the value.
  //  - `table.search`: so that a hand-built `TableInstance` that does not
  //    increment the counter is also synced when the value changes.
  // Extra runs are harmless: the `===` guard below always makes the
  // "is this our own echo" distinction.
  useEffect(() => {
    if (table.search === intendedSearchRef.current) return;
    intendedSearchRef.current = table.search;
    debouncedSetSearch.cancel(); // so that an in-flight keystroke does not overwrite the value that came from outside
    setSearchInput(table.search);
  }, [table.searchRevision, table.search, debouncedSetSearch]);

  const { rowKey } = table;
  const rowKeyGetter = useMemo<(record: T, index?: number) => Key>(() => {
    if (rowKey === undefined) {
      // The type forbids this; if an incomplete instance is passed from JS, it degrades gracefully.
      if (process.env.NODE_ENV !== "production") {
        console.warn("[datatablex] TableInstance.rowKey is missing; rows are rendered with index-based keys.");
      }
      return (_record: T, index?: number) => `__datatablex_row_${index ?? 0}`;
    }
    return (record: T) => resolveRowKey(record, rowKey);
  }, [rowKey]);

  const allColumns = useMemo<ReactDataTableColumn<T>[]>(() => table.columns ?? [], [table.columns]);

  /**
   * Columns with `filterable: true` that have NO automatic filter counterpart
   * would silently stay without a filter, and the developer would notice only
   * when looking for the field in the bar. Because of the reference-stability
   * contract of `columns`, this check in practice runs once (see the duplicate
   * `key` warning in `useDataTable`).
   */
  const unsupportedFilterWarnedRef = useRef(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || unsupportedFilterWarnedRef.current) return;
    // An enum column whose options may come from the server looks like it has no
    // `options` until the meta arrives; once the meta arrives, it either gets its
    // options or is closed out by the hook's own warning.
    const awaitingMeta = typeof table.loadOptions === "function" && table.limits?.maxFilterCount == null;
    const unsupported = allColumns.filter(
      (col) => col.filterable && columnField(col) !== null && ruleKindOf(col) === null && !(awaitingMeta && col.type === "enum" && col.options === undefined),
    );
    if (!unsupported.length) return;
    unsupportedFilterWarnedRef.current = true;
    const detail = unsupported
      .map((col) => `"${col.key}" (type: ${col.type ?? "text"}${col.type === "enum" ? ", options missing" : ""})`)
      .join(", ");
    console.warn(
      `[datatablex] An automatic filter could not be generated for filterable columns: ${detail}. ` +
        "For type: \"enum\", provide `options` (or define `FieldConfig.options` on the server); the `time` and `custom` types have no automatic filter.",
    );
  }, [allColumns, table.loadOptions, table.limits?.maxFilterCount]);

  // The rule limit can only NARROW: a manually given value cannot exceed the
  // one in the meta. The filter bar is the table's only filter interface: it is
  // visible by default when there is a filterable column or a locked filter, and
  // `filterBar={false}` hides it.
  const hasFilterableColumn = useMemo(() => allColumns.some((col) => ruleOperatorsFor(col).length > 0), [allColumns]);
  const filterBarLimits = useMemo(() => {
    if (filterBar === false || (!hasFilterableColumn && !table.lockedFilters)) return null;
    const options = typeof filterBar === "object" ? filterBar : {};
    const narrow = (configured: number | undefined, fromMeta: number | undefined, fallback: number) =>
      configured !== undefined ? Math.min(configured, fromMeta ?? configured) : (fromMeta ?? fallback);
    return {
      mode: options.mode ?? "simple",
      maxRules: narrow(options.maxRules, table.limits?.maxFilterCount ?? undefined, DEFAULT_MAX_FILTER_COUNT),
      maxDepth: narrow(options.maxDepth, table.limits?.maxFilterDepth ?? undefined, DEFAULT_MAX_FILTER_DEPTH),
      maxInValues: table.limits?.maxInValues ?? DEFAULT_MAX_IN_VALUES,
    };
  }, [filterBar, hasFilterableColumn, table.lockedFilters, table.limits]);

  // The header's "Filter" action is a shortcut that adds a rule to the bar;
  // every click is a new request object.
  const [filterRequest, setFilterRequest] = useState<{ field: string; seq: number } | null>(null);
  const requestFilter = useCallback((field: string) => setFilterRequest((prev) => ({ field, seq: (prev?.seq ?? 0) + 1 })), []);

  // The row number virtual column: the row number is the position in the SERVER
  // ordering ((page - 1) × page size + index). It cannot be sorted: the number
  // is not a backend field but the position within the displayed result;
  // reversing the whole result set "by number" would require the primary key to
  // be sortable on the server, or a reverse flag in the protocol. It is hidden
  // by default; its visibility is persisted per `tableId`.
  const { tableId } = table;
  const [rowNumberVisible, setRowNumberVisible] = useState(false);
  useIsomorphicLayoutEffect(() => {
    setRowNumberVisible(tableId ? readRowNumberColumnVisible(tableId) : false);
  }, [tableId]);
  const setRowNumberColumnVisible = useCallback(
    (visible: boolean) => {
      setRowNumberVisible(visible);
      if (tableId) writeRowNumberColumnVisible(tableId, visible);
    },
    [tableId],
  );
  const rowNumberControl = useMemo<VirtualColumnControl>(
    () => ({
      visible: rowNumberVisible,
      onToggle: () => setRowNumberColumnVisible(!rowNumberVisible),
      onReset: () => setRowNumberColumnVisible(false),
    }),
    [rowNumberVisible, setRowNumberColumnVisible],
  );

  const handleColumnResize = useCallback(
    (key: string, newWidth: number) => {
      table.setColumnState(table.columnState.map((cs) => (cs.key === key ? { ...cs, width: newWidth } : cs)));
    },
    [table],
  );

  const columnStateByKey = useMemo(
    () => new Map<string, ColumnState>(table.columnState.map((cs) => [cs.key, cs])),
    [table.columnState],
  );

  /** The visible columns, in the user's order; the Ant Design column definitions are built from this list. */
  const visibleColumns = useMemo<ReactDataTableColumn<T>[]>(() => {
    const cols = allColumns;
    // An unknown column (not yet reconciled) falls to the end instead of tying
    // with `id` and jumping to the front; the reconciliation effect already
    // assigns the correct `order` on the next render, so this only fixes the
    // temporary position in that INTERMEDIATE render.
    const ordered = [...cols].sort(
      (a, b) =>
        (columnStateByKey.get(a.key)?.order ?? Number.POSITIVE_INFINITY) -
        (columnStateByKey.get(b.key)?.order ?? Number.POSITIVE_INFINITY),
    );
    return ordered.filter((col) => !columnStateByKey.get(col.key)?.hidden);
  }, [allColumns, columnStateByKey]);

  /**
   * The counterpart of Ant Design's `sorter: true`: single-column sorting
   * (`multiple` is never given). The ascending and descending sort actions in
   * `ColumnHeaderMenu` keep this behavior exactly: choosing a new direction
   * replaces the previous sorting.
   */
  const handleSortChange = useCallback(
    (key: string, direction: SortDirection) => {
      table.setSorting(direction ? [{ field: key, direction: direction === "ascend" ? "asc" : "desc" }] : []);
    },
    [table],
  );

  /** The content wrapping preference, valid per column and independent of sorting/filtering; it is persisted through `columnState.wrap`. */
  const handleWrapToggle = useCallback(
    (key: string) => {
      table.setColumnState(
        table.columnState.map((cs) => (cs.key === key ? { ...cs, wrap: !(cs.wrap ?? true) } : cs)),
      );
    },
    [table],
  );

  const antdColumns = useMemo<TableProps<T>["columns"]>(() => {
    return visibleColumns.map((col) => {
      // Roles: the column state / menu identity is `key`, sorting and filtering
      // use `field`, and the cell value comes from `accessor`.
      const field = columnField(col);
      const width = columnStateByKey.get(col.key)?.width ?? col.width;
      const onFilterShortcut = filterBarLimits && field !== null && ruleOperatorsFor(col).length ? () => requestFilter(field) : undefined;
      const sortable = Boolean(col.sortable) && field !== null;
      const sortDirection = field === null ? undefined : sortOrderFor(field, table.sorting);
      const wrap = columnStateByKey.get(col.key)?.wrap ?? true;
      return {
        key: col.key,
        title: () => (
          <ColumnHeaderMenu
            column={col}
            title={col.title}
            sortable={sortable}
            sortDirection={sortDirection}
            wrap={wrap}
            density={table.headerDensity}
            onSortChange={(direction) => {
              if (field !== null) handleSortChange(field, direction);
            }}
            onWrapToggle={() => handleWrapToggle(col.key)}
            onFilterShortcut={onFilterShortcut}
          />
        ),
        width,
        fixed: col.fixed,
        // The cell value comes from `accessor`; `render` receives it as its first argument.
        render: (_: unknown, record: T, index: number) => {
          const value = columnValue(col, record);
          return col.render ? col.render(value, record, index) : (value as ReactNode);
        },
        ellipsis: wrap ? undefined : true,
        onHeaderCell: () => ({
          width,
          columnKey: col.key,
          columnLabel: columnLabel(col),
          onResizeCommit: (nextWidth: number) => handleColumnResize(col.key, nextWidth),
          "aria-sort": sortDirection === "ascend" ? "ascending" : sortDirection === "descend" ? "descending" : undefined,
          // The `<th>`'s own padding is reduced to 0 so that the trigger button can
          // fill the whole cell; the padding is moved into `ColumnHeaderMenu`
          // (see `cellPadding`).
          style: { padding: 0 },
        }),
        // Ant Design's `<Table size>` recognizes only "large"/"middle"/"small"; for
        // "compact"/"xsmall"/"mini" the padding produced by the native CSS (always
        // the same as that of "small", 8px) is NOT ENOUGH. The `<td>` padding is
        // therefore applied by hand HERE according to `density`, from the SAME
        // source as the `cellPadding` on the `<th>` (see `density.ts`); otherwise
        // the header and body rows would not match.
        onCell: () => ({
          style: {
            padding: cellPadding(token, table.density),
            ...(col.monospace ? { fontFamily: token.fontFamilyCode } : null),
            ...(col.tabularNums ? { fontVariantNumeric: "tabular-nums" } : null),
          },
        }),
      };
    });
  }, [
    visibleColumns,
    columnStateByKey,
    table.sorting,
    table.density,
    table.headerDensity,
    token,
    handleColumnResize,
    handleSortChange,
    handleWrapToggle,
    filterBarLimits,
    requestFilter,
  ]);

  /**
   * Unless `scroll.x` is given, rc-table picks `tableLayout: "auto"`; in this
   * mode `<col width>` is not a binding hint for the browser and `fixed`
   * columns are not pinned at all. If any column has an explicit width or is
   * `fixed`, `tableLayout="fixed"` is forced; if there is a `fixed` column,
   * the `scroll.x` that Ant Design requires is also provided (the total width of
   * the visible columns, with a default of 150px for columns without a width).
   */
  const { tableLayout, scrollX } = useMemo(() => {
    const cols = antdColumns ?? [];
    const hasExplicitWidth = cols.some((c) => typeof c.width === "number");
    const hasFixed = cols.some((c) => Boolean(c.fixed));
    const totalWidth = cols.reduce((sum, c) => sum + (typeof c.width === "number" ? c.width : 150), 0);
    return {
      tableLayout: (hasExplicitWidth || hasFixed ? "fixed" : undefined) as TableProps<T>["tableLayout"],
      scrollX: hasFixed ? Math.max(totalWidth, 1) : undefined,
    };
  }, [antdColumns]);

  // Pagination is rendered outside `<Table>`, in its own row: Ant Design's
  // in-table pagination puts the `showTotal` summary right next to the buttons;
  // so that the summary stays on the left and the buttons on the right, the two
  // are separate flex items. Since sorting and filtering do not go through
  // `<Table onChange>` anyway (see `ColumnHeaderMenu`, `FilterBar`), the table
  // needs no `onChange`.
  const { current, pageSize, total } = table.pagination;
  const rangeFrom = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const rangeTo = Math.min(current * pageSize, total);
  const handlePageChange = useCallback(
    (nextPage: number, nextPageSize: number) => {
      if (nextPage !== table.pagination.current || nextPageSize !== table.pagination.pageSize) {
        table.pagination.onChange(nextPage, nextPageSize);
      }
    },
    [table],
  );

  // The header has no background (Ant Design's gray `headerBg` is removed) and
  // there is no vertical separator between the column names (`headerSplitColor`
  // is the color of the cells' `::before` line). Because the cells of fixed
  // columns are already painted with the container color in Ant Design, content
  // does not show under the header while scrolling. `fontFamily={false}` leaves
  // only the font to the consumer's theme; this theme is still applied.
  const tableTheme = useMemo(
    () => ({
      token: { fontFamily: fontFamily || undefined },
      components: { Table: { headerBg: "transparent", headerSplitColor: "transparent" } },
    }),
    [fontFamily],
  );

  // The visibility of the selection column is independent of `columnState` (it
  // is a virtual column, see `readSelectionColumnVisible`). While it is hidden,
  // `rowSelection` is not passed, but the selected keys are KEPT in the `table`
  // state; the summary bar and the "selected" export keep working, and the
  // selection is cleared with "clear selection". The first render uses the
  // default (visible); the stored value is applied after hydration (see
  // `useDataTable`).
  const [selectionVisible, setSelectionVisible] = useState(true);
  useIsomorphicLayoutEffect(() => {
    setSelectionVisible(tableId ? readSelectionColumnVisible(tableId) : true);
  }, [tableId]);
  const setSelectionColumnVisible = useCallback(
    (visible: boolean) => {
      setSelectionVisible(visible);
      if (tableId) writeSelectionColumnVisible(tableId, visible);
    },
    [tableId],
  );
  const selectionControl = useMemo<VirtualColumnControl | undefined>(
    () =>
      selectable
        ? {
            visible: selectionVisible,
            onToggle: () => setSelectionColumnVisible(!selectionVisible),
            onReset: () => setSelectionColumnVisible(true),
          }
        : undefined,
    [selectable, selectionVisible, setSelectionColumnVisible],
  );

  const rowSelection: TableProps<T>["rowSelection"] | undefined = selectable && selectionVisible
    ? {
        selectedRowKeys: table.selectedRowKeys,
        onChange: (keys) => table.setSelectedRowKeys(keys),
        preserveSelectedRowKeys: true, // so that the selection is not lost when the page changes
      }
    : undefined;

  // The row number column stays at the far left, even IN FRONT of the selection
  // column that Ant Design puts first on its own (`Table.SELECTION_COLUMN`
  // determines the position explicitly).
  const hasRowSelection = rowSelection !== undefined;
  const rowNumberOffset = (table.pagination.current - 1) * table.pagination.pageSize;
  const tableColumns = useMemo<TableProps<T>["columns"]>(() => {
    if (!rowNumberVisible) return antdColumns;
    const rowNumberColumn: NonNullable<TableProps<T>["columns"]>[number] = {
      key: ROW_NUMBER_COLUMN_KEY,
      // No header menu, because the column cannot be sorted and wrapping is meaningless; the padding comes from the same source as the other headers.
      title: () => <div style={{ padding: cellPadding(token, table.headerDensity) }}>{locale.rowNumberColumn}</div>,
      width: ROW_NUMBER_COLUMN_WIDTH,
      render: (_: unknown, _record: T, index: number) => rowNumberOffset + index + 1,
      onHeaderCell: () => ({ style: { padding: 0 } }),
      onCell: () => ({ style: { padding: cellPadding(token, table.density), fontVariantNumeric: "tabular-nums" } }),
    };
    return [rowNumberColumn, ...(hasRowSelection ? [Table.SELECTION_COLUMN] : []), ...(antdColumns ?? [])];
  }, [rowNumberVisible, antdColumns, locale, rowNumberOffset, table.headerDensity, table.density, token, hasRowSelection]);

  const selectedCount = table.selectedRowKeys.length;
  const showSelectionSummary = Boolean(selectable) && selectedCount > 0;
  const hasToolbar = Boolean(searchable || columnManagement || showSelectionSummary || exportDefinition);
  const runExport = useCallback(
    (format: ExportFormat, scope: ExportScope) => {
      table.exportData(format, scope, { title: locale.exportDocumentTitle }).then(
        (outcome) => {
          if (outcome === "started") messageApi.success(locale.exportStarted);
        },
        (cause: unknown) => {
          if (isExportRowLimitError(cause)) {
            messageApi.error(cause.source === "client" ? locale.exportRowLimitClient(cause.maxRows, cause.format) : locale.exportRowLimitServer(cause.maxRows));
            return;
          }
          if (isExportBusyError(cause)) {
            messageApi.warning(locale.exportBusy);
            return;
          }
          messageApi.error(cause instanceof Error ? <ErrorDescription {...errorText(cause, locale)} /> : locale.exportFailed);
        },
      );
    },
    [locale, messageApi, table],
  );

  const content = (
    <Space direction="vertical" style={{ width: "100%" }}>
      {messageContextHolder}
      {/*
        The filter bar and the toolbar share a single row: the bar fills the
        remaining space on the left, and the toolbar (`marginInlineStart: auto`)
        is pushed to the right edge. The toolbar is on the right even when the
        bar is off; on a narrow screen it wraps below. The bar's container has
        the height of a small button (24px) so that a single-line bar lines up
        with the buttons; if it has several lines, it starts from the top. The
        selection counter is to the left of the buttons, so appearing and
        disappearing does not shift the buttons.
      */}
      {filterBarLimits || hasToolbar ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 8 }}>
          {filterBarLimits ? (
            <div style={{ flex: "1 1 320px", minWidth: 0, minHeight: 24, display: "flex", alignItems: "center" }}>
              <FilterBar
                table={table}
                columns={allColumns}
                maxRules={filterBarLimits.maxRules}
                maxInValues={filterBarLimits.maxInValues}
                mode={filterBarLimits.mode}
                maxDepth={filterBarLimits.maxDepth}
                request={filterRequest}
              />
            </div>
          ) : null}
          {hasToolbar ? (
            <Space wrap size={8} style={{ marginInlineStart: "auto" }}>
              {searchable ? (
                <Input.Search
                  value={searchInput}
                  maxLength={table.limits?.maxSearchLength}
                  onChange={(e) => {
                    setSearchInput(e.target.value);
                    intendedSearchRef.current = e.target.value;
                    debouncedSetSearch.run(e.target.value);
                  }}
                  placeholder={locale.searchPlaceholder}
                  allowClear
                  size="small"
                  style={{ maxWidth: 320 }}
                />
              ) : null}
              {/*
                Because the selection is PRESERVED across filter/search/page
                changes, and the `selected` export is not combined with the active
                filters, the counter must always be visible.
              */}
              {showSelectionSummary ? (
                <Space size={4} data-testid="selection-summary">
                  <Typography.Text>{locale.selectedCount(selectedCount)}</Typography.Text>
                  <Button type="link" size="small" onClick={() => table.setSelectedRowKeys([])}>
                    {locale.clearSelection}
                  </Button>
                </Space>
              ) : null}
              {columnManagement ? (
                <Popover content={<ColumnManagementPanel table={table} selection={selectionControl} rowNumber={rowNumberControl} />} trigger="click" placement="bottomRight">
                  <Button size="small" icon={<ColumnsIcon />}>
                    {locale.columns}
                  </Button>
                </Popover>
              ) : null}
              {exportDefinition ? (
                <ExportMenu
                  definition={exportDefinition}
                  selectedCount={selectedCount}
                  isExporting={table.isExporting}
                  progress={table.exportProgress}
                  onExport={runExport}
                  loading={table.loading}
                  onCancel={table.cancelExport}
                  selectionBlocked={table.exportSelectionBlocked}
                />
              ) : null}
            </Space>
          ) : null}
        </div>
      ) : null}
      {table.error ? (errorRender ? <>{errorRender(table.error, table.reload)}</> : <DefaultErrorAlert table={table} error={table.error} />) : null}
      <Table<T>
        dataSource={table.data}
        columns={tableColumns}
        rowKey={rowKeyGetter}
        loading={table.loading}
        size={ANTD_SIZE_FOR_DENSITY[table.density]}
        components={{ header: { cell: ResizableTitle } }}
        tableLayout={tableLayout}
        scroll={scrollX ? { x: scrollX } : undefined}
        pagination={false}
        rowSelection={rowSelection}
        locale={{ emptyText: empty ?? <Empty description={locale.emptyText} /> }}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <Typography.Text>{locale.paginationTotal(rangeFrom, rangeTo, total)}</Typography.Text>
        <Pagination
          current={current}
          pageSize={pageSize}
          total={total}
          showSizeChanger
          size={ANTD_SIZE_FOR_DENSITY[table.density] === "large" ? undefined : "small"}
          onChange={handlePageChange}
        />
      </div>
    </Space>
  );

  const localized = <DataTableLocaleContext.Provider value={locale}>{content}</DataTableLocaleContext.Provider>;
  return <ConfigProvider theme={tableTheme}>{localized}</ConfigProvider>;
}

function DataTableFromOptions<T>(props: UseDataTableOptions<T> & CommonProps) {
  const table = useDataTable(props);
  return (
    <DataTableInner
      table={table}
      searchable={props.searchable}
      selectable={props.selectable}
      columnManagement={props.columnManagement}
      export={props.export}
      empty={props.empty}
      errorRender={props.errorRender}
      fontFamily={props.fontFamily}
      locale={props.locale}
      filterBar={props.filterBar}
    />
  );
}

/**
 * The Ant Design v5 data table: a toolbar (search, column management, export),
 * a filter bar, sortable and resizable columns, optional row selection and a
 * pagination row, all rendered from a `TableInstance` produced by
 * `useDataTable` from `@datatablex/react`.
 *
 * It accepts one of two forms, and they cannot be given together:
 *
 * - **Options:** all the options of `useDataTable` (`dataSource`, `columns`,
 *   `rowKey`, `tableId`, `lockedFilters`, ...) are passed as props, and the
 *   component calls the hook itself.
 * - **Instance:** a ready `table`, the return value of `useDataTable`. The
 *   caller owns the state, so `table.reload()`, `table.reset()` and controls
 *   outside the table can reach it; the hook options are not passed.
 *
 * The interface props (`searchable`, `selectable`, `columnManagement`,
 * `export`, `empty`, `errorRender`, `fontFamily`, `locale`, `filterBar`) are
 * common to both forms. The texts the table produces come from `locale`, which
 * is merged over the default `enUS`; Ant Design's own texts are set through
 * `ConfigProvider.locale`.
 *
 * The hook call is split into two sub-components so that `useDataTable` is
 * called in the same, unconditional order on EVERY render (Rules of Hooks);
 * the dispatcher itself calls no hook.
 *
 * @example Hook options passed directly as props
 * ```tsx
 * import { DataTable } from "@datatablex/antd";
 * import { createRestDataSource } from "@datatablex/react";
 * import type { ReactDataTableColumn } from "@datatablex/react";
 *
 * const columns: ReactDataTableColumn<AccessLog>[] = [
 *   { key: "id", title: "ID" },
 *   { key: "stadiumName", title: "Stadium", type: "text", sortable: true, searchable: true },
 * ];
 *
 * const dataSource = createRestDataSource<AccessLog>({
 *   endpoint: "/api/access-logs/query",
 *   metaEndpoint: "/api/access-logs/query/meta",
 * });
 *
 * export function AccessLogsTable() {
 *   return <DataTable dataSource={dataSource} columns={columns} rowKey="id" tableId="access-logs" searchable columnManagement />;
 * }
 * ```
 *
 * @example A ready table instance
 * ```tsx
 * import { DataTable } from "@datatablex/antd";
 * import { useDataTable } from "@datatablex/react";
 *
 * export function AccessLogsTable() {
 *   const table = useDataTable<AccessLog>({ dataSource, columns, rowKey: "id" });
 *   return (
 *     <>
 *       <button onClick={() => void table.reload()}>Refresh</button>
 *       <DataTable table={table} searchable selectable />
 *     </>
 *   );
 * }
 * ```
 */
export function DataTable<T>(props: DataTableProps<T>) {
  if (props.table !== undefined) {
    const { table, searchable, selectable, columnManagement, export: exportDefinition, empty, errorRender, fontFamily, locale, filterBar } = props;
    return (
      <DataTableInner
        table={table}
        searchable={searchable}
        selectable={selectable}
        columnManagement={columnManagement}
        export={exportDefinition}
        empty={empty}
        errorRender={errorRender}
        fontFamily={fontFamily}
        locale={locale}
        filterBar={filterBar}
      />
    );
  }
  return <DataTableFromOptions {...props} />;
}
