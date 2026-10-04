import type { ExportFormat } from "../types.js";

/**
 * The row count of the export exceeds a ceiling. `source: "client"` is the
 * `maxClientExportRows` ceiling of a format produced in browser memory (a
 * server export or narrower filters are suggested); `source: "server"` is the
 * `export.maxRows` of the server (413; the filters must be narrowed). When
 * `format` is known, it says which format exceeded the ceiling.
 */
export class ExportRowLimitError extends Error {
  /** Machine-readable error code. */
  readonly code = "export_too_large" as const;
  /** Number of rows the export would contain. */
  readonly total: number;
  /** The ceiling that `total` exceeds. */
  readonly maxRows: number;
  /** Which ceiling was hit: the browser-side one or the server's. */
  readonly source: "client" | "server";
  /** The format that exceeded the ceiling; it is not known from a server 413 body (`undefined`). */
  readonly format: ExportFormat | undefined;
  constructor(total: number, maxRows: number, source: "client" | "server", format?: ExportFormat) {
    super(
      source === "client"
        ? `[datatablex] ${format === "csv" ? "CSV" : "This format"} produces at most ${maxRows} rows in the browser; the export has ${total} rows. ${format === "csv" ? "Use the server export, deliberately raise the ceiling (maxClientExportRows)," : "Use CSV,"} or narrow the filters.`
        : `[datatablex] The server exports at most ${maxRows} rows; the export has ${total} rows. Narrow the filters.`,
    );
    this.name = "ExportRowLimitError";
    this.total = total;
    this.maxRows = maxRows;
    this.source = source;
    this.format = format;
  }
}

/**
 * The server is at its ceiling of concurrently streaming exports
 * (`export.maxConcurrent`, 429). This is not permanent; it can be retried a
 * little later.
 */
export class ExportBusyError extends Error {
  /** Machine-readable error code. */
  readonly code = "export_busy" as const;
  /** The server's concurrent export limit, or `null` when the response did not report it. */
  readonly maxConcurrent: number | null;
  constructor(maxConcurrent: number | null) {
    super("[datatablex] The server is currently producing other exports; try again in a moment.");
    this.name = "ExportBusyError";
    this.maxConcurrent = maxConcurrent;
  }
}

/**
 * User-facing errors caught on the client before the export starts (no
 * selection, the table is loading, no visible column, and so on). `message`
 * is meant for developers and is in English; the UI translates `code` into
 * its own language.
 */
export class DataTableExportError extends Error {
  /** Machine-readable error code; the UI maps it to a localized message. */
  readonly code: "no_rows_selected" | "export_table_loading" | "export_no_columns" | "export_selection_key" | "export_incomplete";
  constructor(code: DataTableExportError["code"], message: string) {
    super(message);
    this.name = "DataTableExportError";
    this.code = code;
  }
}
/** Tells whether `err` is an `ExportRowLimitError`. Structural (safe across duplicate copies of the package), like `isDataTableRequestError`. */
export function isExportRowLimitError(err: unknown): err is ExportRowLimitError {
  if (!(err instanceof Error) || err.name !== "ExportRowLimitError") return false;
  const { maxRows, source } = err as { maxRows?: unknown; source?: unknown };
  return typeof maxRows === "number" && (source === "client" || source === "server");
}

/** Tells whether `err` is an `ExportBusyError`. Structural (safe across duplicate copies of the package), like `isDataTableRequestError`. */
export function isExportBusyError(err: unknown): err is ExportBusyError {
  return err instanceof Error && err.name === "ExportBusyError";
}