/**
 * The visibility of the selection column is kept in localStorage per
 * `tableId`. It is separate from the column state because the selection column
 * is not defined in `columns`.
 */
const SELECTION_STORAGE_PREFIX = "datatablex:selection-column:";

/** Reads whether the selection column is visible for a table. Visible unless it was hidden; storage errors read as visible. */
export function readSelectionColumnVisible(tableId: string): boolean {
  try {
    return window.localStorage.getItem(`${SELECTION_STORAGE_PREFIX}${tableId}`) !== "hidden";
  } catch {
    return true;
  }
}

/** Stores the visibility of the selection column for a table; showing it deletes the entry. */
export function writeSelectionColumnVisible(tableId: string, visible: boolean): void {
  try {
    if (visible) window.localStorage.removeItem(`${SELECTION_STORAGE_PREFIX}${tableId}`);
    else window.localStorage.setItem(`${SELECTION_STORAGE_PREFIX}${tableId}`, "hidden");
  } catch {
    // If storage is unavailable (private window, quota), the preference only lasts for this session.
  }
}
