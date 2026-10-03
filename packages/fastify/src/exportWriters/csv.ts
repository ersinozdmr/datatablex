import { CSV_BOM, CSV_LINE_BREAK, csvRow } from "@datatablex/core";
import type { ExportColumnSpec, ExportWriter } from "./types.js";
import { createOutput } from "./passThrough.js";

/** Largest amount of text written to the response in one chunk, so each row does not cause a separate write. */
const FLUSH_CHARS = 64 * 1024;

/** Creates the CSV writer. The UTF-8 BOM, RFC 4180 quoting and formula-prefix escaping come from `csvRow` in `@datatablex/core`. */
export function createCsvWriter(columns: ExportColumnSpec[]): ExportWriter {
  const { out, congested } = createOutput();
  // PostgreSQL `numeric`/`bigint` come back from the driver as text ("-12.50"); number fields must not get the formula prefix.
  const numericColumns = columns.map((c) => c.type === "number");
  let buffer = CSV_BOM + csvRow(columns.map((c) => c.title)) + CSV_LINE_BREAK;
  const flush = () => {
    if (buffer) out.write(buffer);
    buffer = "";
  };
  return {
    out,
    congested,
    writeRow(values) {
      buffer += csvRow(values, ",", numericColumns) + CSV_LINE_BREAK;
      if (buffer.length >= FLUSH_CHARS) flush();
    },
    async end() {
      flush();
      out.end();
    },
    abort(error) {
      buffer = "";
      out.destroy(error instanceof Error ? error : undefined);
    },
  };
}
