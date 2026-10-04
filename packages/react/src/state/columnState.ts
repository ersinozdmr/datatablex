import type { ColumnState, ReactDataTableColumn } from "../types.js";

const STORAGE_PREFIX = "datatablex:columns:";

function storageKey(tableId: string): string {
  return `${STORAGE_PREFIX}${tableId}`;
}

/** Builds the default column state from the `columns` option: the order of the array, `defaultHidden`, `width`, and wrapping on. */
export function defaultColumnState<T>(columns: ReactDataTableColumn<T>[]): ColumnState[] {
  return columns.map((col, index) => ({
    key: col.key,
    hidden: col.defaultHidden ?? false,
    width: col.width,
    order: index,
    wrap: true,
  }));
}

interface RawEntry {
  hidden?: boolean;
  width?: number;
  order?: number;
  wrap?: boolean;
}

/**
 * The record read from localStorage and the array passed to `setColumnState`
 * from outside go through the SAME normalization. Reconciliation covers not
 * only which keys exist in the record but also whether the values in the
 * record are VALID. Summary of the rules:
 * - A `key` that is not in `columns` is dropped; when the same `key` is
 *   repeated, only the first occurrence is considered.
 * - If `order` is not a finite integer, that column counts as "unrecorded" and
 *   is placed by its index in the `columns` array, AFTER the entries that have
 *   a valid order.
 * - If `width` is not finite and positive, it falls back to `column.width`.
 * - The output always has exactly the length of `columns`, and the `order`
 *   field is REASSIGNED to run 0..n-1.
 * - If the record (or the caller) leaves ALL columns hidden, the FIRST column
 *   in order is forced visible: "at least one visible column" holds here as
 *   well, not only in the panel UI.
 */
export function normalizeColumnState<T>(raw: unknown, columns: ReactDataTableColumn<T>[]): ColumnState[] {
  const knownKeys = new Set(columns.map((c) => c.key));
  const byKey = new Map<string, RawEntry>();

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const key = (entry as { key?: unknown }).key;
      if (typeof key !== "string" || !knownKeys.has(key) || byKey.has(key)) continue;

      const hiddenRaw = (entry as { hidden?: unknown }).hidden;
      const widthRaw = (entry as { width?: unknown }).width;
      const orderRaw = (entry as { order?: unknown }).order;
      const wrapRaw = (entry as { wrap?: unknown }).wrap;

      byKey.set(key, {
        hidden: typeof hiddenRaw === "boolean" ? hiddenRaw : undefined,
        width: typeof widthRaw === "number" && Number.isFinite(widthRaw) && widthRaw > 0 ? widthRaw : undefined,
        order: typeof orderRaw === "number" && Number.isFinite(orderRaw) && Number.isInteger(orderRaw) ? orderRaw : undefined,
        wrap: typeof wrapRaw === "boolean" ? wrapRaw : undefined,
      });
    }
  }

  const withOrder: Array<{ col: ReactDataTableColumn<T>; index: number; order: number }> = [];
  const withoutOrder: Array<{ col: ReactDataTableColumn<T>; index: number }> = [];

  columns.forEach((col, index) => {
    const order = byKey.get(col.key)?.order;
    if (order !== undefined) withOrder.push({ col, index, order });
    else withoutOrder.push({ col, index });
  });

  withOrder.sort((a, b) => a.order - b.order || a.index - b.index);
  withoutOrder.sort((a, b) => a.index - b.index);

  const ordered = [...withOrder, ...withoutOrder];
  // "At least one visible column" is enforced by the checkbox in the panel,
  // but the panel is only the UI path: the public `setColumnState`, or a
  // hand-edited or stale localStorage record, could bypass the same invariant
  // and leave every column hidden. The output of normalization makes that
  // structurally impossible: when none is visible, the FIRST column is left
  // visible.
  const allHidden = ordered.length > 0 && ordered.every(({ col }) => (byKey.get(col.key)?.hidden ?? col.defaultHidden ?? false));

  return ordered.map(({ col }, position) => {
    const stored = byKey.get(col.key);
    const hidden = stored?.hidden ?? col.defaultHidden ?? false;
    return {
      key: col.key,
      hidden: allHidden && position === 0 ? false : hidden,
      width: stored?.width ?? col.width,
      order: position,
      wrap: stored?.wrap ?? true,
    };
  });
}

/**
 * Compares two column states by content. The effect that reconciles again when
 * the `columns` option changes must not produce a needless `setState` (and so
 * a new `TableInstance` identity), which is why the previous array reference
 * has to be kept when the content is equal.
 */
export function columnStateEqual(a: ColumnState[], b: ColumnState[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      item.key === other.key &&
      item.order === other.order &&
      (item.hidden ?? false) === (other.hidden ?? false) &&
      item.width === other.width &&
      (item.wrap ?? true) === (other.wrap ?? true)
    );
  });
}

/** Reads the stored column state record. Returns `null` for corrupt or stale JSON (a different `schemaVersion`), so the caller falls back to the default with `normalizeColumnState(null, columns)`. */
export function readColumnStateRecord(tableId: string, schemaVersion: number): unknown {
  try {
    const raw = window.localStorage.getItem(storageKey(tableId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; columnState?: unknown };
    if (parsed.schemaVersion !== schemaVersion) return null;
    return parsed.columnState ?? null;
  } catch {
    return null;
  }
}

/** Writes the column state record. localStorage may be unavailable or full (a private tab, a quota), so persistence is best-effort and must not crash the hook. */
export function writeColumnStateRecord(tableId: string, schemaVersion: number, columnState: ColumnState[]): void {
  try {
    window.localStorage.setItem(storageKey(tableId), JSON.stringify({ schemaVersion, columnState }));
  } catch {
    // see the note above
  }
}

/** Deletes the stored column state record, so the table returns to the defaults. Failures are ignored, like the write. */
export function clearColumnStateRecord(tableId: string): void {
  try {
    window.localStorage.removeItem(storageKey(tableId));
  } catch {
    // see writeColumnStateRecord
  }
}
