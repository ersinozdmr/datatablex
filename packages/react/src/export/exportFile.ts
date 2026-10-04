import { CSV_BOM, CSV_LINE_BREAK, columnField, columnValue, csvCell, csvRow } from "@datatablex/core";
import type { ReactDataTableColumn, ColumnState, ExportFormat } from "../types.js";
import type { DocumentExporter } from "./exporter.js";
import { normalizeExportCell } from "./cell.js";
import type { ExportCell } from "./cell.js";

export type { ExportCell } from "./cell.js";

/** A column of an export file. */
export interface ExportColumn<T> {
  /** Key of the table column this export column comes from. */
  key: string;
  /** Header text written to the file. */
  title: string;
  /** Reads the cell value of a record. */
  value: (record: T) => ExportCell;
  /**
   * The column is a number column (`number`/`currency`): on REST sources,
   * PostgreSQL `numeric`/`bigint` come back as text (`"-12.50"`); CSV writes
   * this text without the formula prefix. Text that does not look like a
   * number is still prefixed (see `csvCell`).
   */
  numeric?: boolean;
}

/** The file follows the order of the columns visible on screen exactly. */
export function exportColumnsFor<T>(columns: ReactDataTableColumn<T>[], columnState: ColumnState[]): ExportColumn<T>[] {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  return [...columnState]
    .sort((a, b) => a.order - b.order)
    .flatMap((state) => {
      const column = byKey.get(state.key);
      if (!column || state.hidden || column.exportable === false) return [];
      // The raw value is used only when there is NO formatter at all. A `null`
      // returned by `exportValue` is a deliberate empty cell (for example
      // redaction); combining with `??` would replace it with the raw value.
      // Both paths are reduced to an `ExportCell` at run time: a raw accessor
      // can return an object, and in Excel that would become a formula or
      // link cell.
      const { exportValue } = column;
      return [{
        key: column.key,
        title: column.exportTitle ?? (typeof column.title === "string" ? column.title : column.key),
        numeric: column.type === "number" || column.type === "currency",
        value: exportValue
          ? (record: T) => normalizeExportCell(exportValue(record))
          : (record: T) => normalizeExportCell(columnValue(column, record)),
      }];
    });
}

/**
 * Builds the CSV text. It includes a UTF-8 BOM so that Excel opens non-ASCII
 * characters (such as Turkish ones) correctly. The cell rule (quoting,
 * formula escaping) is `csvCell` from `@datatablex/core`; the server export
 * uses the same one.
 */
export function csvContent<T>(columns: ExportColumn<T>[], rows: T[], delimiter = ","): string {
  return `${CSV_BOM}${csvRows(columns, rows, delimiter, true)}`;
}

function csvRows<T>(columns: ExportColumn<T>[], rows: T[], delimiter: string, includeHeader = false): string {
  const lines = includeHeader ? [columns.map((column) => csvCell(column.title)).join(delimiter)] : [];
  const numericColumns = columns.map((column) => column.numeric === true);
  lines.push(...rows.map((row) => csvRow(columns.map((column) => column.value(row)), delimiter, numericColumns)));
  return `${lines.join(CSV_LINE_BREAK)}${CSV_LINE_BREAK}`;
}

/**
 * The columns of a server export: the order on screen, visibility and
 * `exportable` are followed exactly. The server reads the CELL VALUE from the
 * backend field: the field is the one behind the displayed value (a string
 * `accessor`, otherwise `field`). Columns with a function `accessor` or with
 * `field: null` (computed), and, when `allowed` is given, fields that are not
 * in the export whitelist are skipped; the skipped ones are returned in
 * `skipped`. The client's `exportValue` does not run on this path: formatting
 * is the server's `export.formatter`.
 */
export function serverExportColumnsFor<T>(
  columns: ReactDataTableColumn<T>[],
  columnState: ColumnState[],
  allowed: ReadonlySet<string> | null,
): { columns: Array<{ field: string; title: string }>; skipped: string[] } {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const out: Array<{ field: string; title: string }> = [];
  const skipped: string[] = [];
  for (const state of [...columnState].sort((a, b) => a.order - b.order)) {
    const column = byKey.get(state.key);
    if (!column || state.hidden || column.exportable === false) continue;
    const field = typeof column.accessor === "string" ? column.accessor : column.accessor ? null : columnField(column);
    if (field === null || (allowed && !allowed.has(field))) {
      skipped.push(column.key);
      continue;
    }
    out.push({ field, title: column.exportTitle ?? (typeof column.title === "string" ? column.title : column.key) });
  }
  return { columns: out, skipped };
}

/** Saves `blob` to the user's device under `filename`. Only available in a browser environment. */
export function downloadBlob(blob: Blob, filename: string): void {
  download(blob, filename);
}

/**
 * The native download of a server export: the browser downloads the file
 * itself, and the body does not enter JavaScript or memory. On the same
 * origin the `download` attribute keeps the page from navigating away; on a
 * different origin the attribute is ignored and the `Content-Disposition:
 * attachment` of the response (which the server also sends on error
 * responses) makes it a download.
 *
 * @throws {Error} When there is no `document` (outside a browser environment).
 */
export function startDownload(url: string, filename: string): void {
  if (typeof document === "undefined") {
    throw new Error("[datatablex] File download is only available in a browser environment.");
  }
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function download(blob: Blob, filename: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("[datatablex] File download is only available in a browser environment.");
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Builds the CSV of `rows` and saves it as `filename`. Only available in a browser environment. */
export function downloadCsv<T>(columns: ExportColumn<T>[], rows: T[], filename: string): void {
  download(new Blob([csvContent(columns, rows)], { type: "text/csv;charset=utf-8" }), filename);
}

/**
 * The download of the client path (a source without a server export): the CSV
 * rows are collected in memory; for Excel/PDF the file is the `Blob` produced
 * by the adapter. When `format` is not `"csv"` but `document` is `null`, CSV
 * is produced.
 *
 * @throws {Error} When `columns` is empty, or when there is no `document` (outside a browser environment).
 */
export async function downloadExport<T>(
  format: ExportFormat,
  columns: ExportColumn<T>[],
  rows: T[],
  filename: string,
  document: { exporter: DocumentExporter; title: string } | null,
): Promise<void> {
  if (!columns.length) throw new Error("[datatablex] There is no visible column to export.");
  if (format === "csv" || !document) downloadCsv(columns, rows, filename);
  else download(await document.exporter.build(columns, rows, { title: document.title }), filename);
}
