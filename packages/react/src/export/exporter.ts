import type { ExportColumn } from "./exportFile.js";

/**
 * An export format that produces a file (`Blob`) in memory: Excel and PDF.
 * The hook manages "Save as", the download fallback, paged fetching, progress
 * and cancellation; the adapter only produces the file and loads its library
 * itself (dynamically). CSV lives inside the hook and has no dependency, but
 * it does not STREAM the rows to a file either: all rows are collected in
 * memory and turned into a single text and a `Blob` (which is why CSV also has
 * a row ceiling on the client path, `maxClientExportRows`). The path that
 * really streams the rows is the server export.
 *
 * Ready-made adapters: `@datatablex/react/excel` (`excelExporter`) and
 * `@datatablex/react/pdf` (`pdfExporter`). They are registered with
 * `useDataTable({ exporters: [...] })`.
 *
 * @experimental May change in any release while the package is in 0.x.
 */
export interface DocumentExporter {
  /** The export format this adapter produces. */
  readonly format: "excel" | "pdf";
  /** Extension of the default file name, without the dot (`"xlsx"`). */
  readonly extension: string;
  /** MIME type of the produced file. */
  readonly mimeType: string;
  /** The file type label in the "Save as" dialog. */
  readonly description: string;
  /** Produces the file from the visible columns and the rows; `options.title` is the document title. */
  build<T>(columns: ExportColumn<T>[], rows: T[], options: { title: string }): Promise<Blob>;
}
