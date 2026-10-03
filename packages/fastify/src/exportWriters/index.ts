import type { DataTableServerExportFormat } from "@datatablex/core";
import type { ExportColumnSpec, ExportWriter, ExportWriterOptions } from "./types.js";
import { createCsvWriter } from "./csv.js";
import { createXlsxWriter } from "./xlsx.js";
import { createPdfWriter } from "./pdf.js";

export type { ExportColumnSpec, ExportWriter } from "./types.js";

/** Response `Content-Type` for each export format. */
export const EXPORT_CONTENT_TYPE: Record<DataTableServerExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

/** File extension (without the dot) for each export format. */
export const EXPORT_EXTENSION: Record<DataTableServerExportFormat, string> = { csv: "csv", excel: "xlsx", pdf: "pdf" };

/**
 * Creates the streaming writer for a format.
 *
 * @throws When a writer cannot be created, for example the `exceljs` or `pdfkit` package cannot be loaded or the PDF font is unusable.
 */
export async function createExportWriter(
  format: DataTableServerExportFormat,
  columns: ExportColumnSpec[],
  options: ExportWriterOptions,
): Promise<ExportWriter> {
  switch (format) {
    case "csv":
      return createCsvWriter(columns);
    case "excel":
      return createXlsxWriter(columns);
    case "pdf":
      return createPdfWriter(columns, options);
  }
}
