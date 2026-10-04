/**
 * The visibility of the "No" (row number) column is kept in localStorage per
 * `tableId`. Like the selection column, it is a virtual column that is not
 * defined in `columns`. Unlike the selection column, it is HIDDEN BY DEFAULT:
 * an entry is written only when it was explicitly turned on ("visible"), and
 * "Reset View" returns to hidden by deleting the entry.
 */
const ROW_NUMBER_STORAGE_PREFIX = "datatablex:row-number-column:";

/** The `ColumnHeaderMenu` / Ant Design `key` of the virtual column. It starts with a double underscore so that it cannot collide with a real column key. */
export const ROW_NUMBER_COLUMN_KEY = "__datatablex_row_number";

/** Reads whether the row number column is visible for a table. Hidden unless it was turned on; storage errors read as hidden. */
export function readRowNumberColumnVisible(tableId: string): boolean {
  try {
    return window.localStorage.getItem(`${ROW_NUMBER_STORAGE_PREFIX}${tableId}`) === "visible";
  } catch {
    return false;
  }
}

/** Stores the visibility of the row number column for a table; hiding it deletes the entry. */
export function writeRowNumberColumnVisible(tableId: string, visible: boolean): void {
  try {
    if (visible) window.localStorage.setItem(`${ROW_NUMBER_STORAGE_PREFIX}${tableId}`, "visible");
    else window.localStorage.removeItem(`${ROW_NUMBER_STORAGE_PREFIX}${tableId}`);
  } catch {
    // If storage is unavailable (private window, quota), the preference only lasts for this session.
  }
}
