import type { Readable } from "node:stream";
import type { FieldType } from "../types.js";

/** A column of the exported file. */
export interface ExportColumnSpec {
  /** Key of the field in the endpoint's field config; also the key of the value in each row. */
  field: string;
  /** Header text written for the column. */
  title: string;
  /** Backend field type — decides the cell type in XLSX and the text in PDF. */
  type: FieldType;
}

/** Options passed to a writer when it is created. */
export interface ExportWriterOptions {
  /** PDF document title and metadata. */
  title: string;
  /** Font files for the PDF writer (a path or the font bytes); `bold` falls back to `regular` when omitted. Not used by the CSV and XLSX writers. */
  pdfFont?: { regular: string | Uint8Array; bold?: string | Uint8Array };
}

/**
 * The streaming writer of a format. Rows are written synchronously; as long as
 * `congested()` returns true, the export core (`openDataTableExport`) does not
 * read new rows from the database. This way a slow client cannot grow server
 * memory: at most one row of excess accumulates in the library's internal
 * buffers.
 */
export interface ExportWriter {
  /** File body. It finishes with `end()` and is destroyed by `abort()`. */
  readonly out: Readable;
  /** Writes one row; `values` follow the order of the columns the writer was created with. */
  writeRow(values: unknown[]): void;
  /** Whether the output buffer is full; if so, the producer waits for the consumer to read. */
  congested(): boolean;
  /** Writes the final chunks and ends `out`. */
  end(): Promise<void>;
  /** Stops writing and destroys `out` (with the error, if one is given). */
  abort(error?: unknown): void;
}

/** Maximum number of bytes that may be buffered without waiting for the consumer to read. */
export const WRITER_HIGH_WATER_MARK = 256 * 1024;
