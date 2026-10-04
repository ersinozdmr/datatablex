import type { DocumentExporter } from "./export/exporter.js";
import type { ExportColumn } from "./export/exportFile.js";
import { normalizeExportCell } from "./export/cell.js";

const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Builds the `.xlsx` file. String values are deliberately written as strings;
 * ExcelJS treats only the `{ formula: ... }` form as a formula, so text cells
 * are not open to formula injection and the visible `'` prefix used in CSV is
 * not needed.
 */
async function excelBlob<T>(columns: ExportColumn<T>[], rows: T[]): Promise<Blob> {
  let ExcelJS: typeof import("exceljs");
  try {
    // ExcelJS is CommonJS: Node's ESM loader (and bundlers that leave the peer
    // external) expose `module.exports` under `default`, and `Workbook` is not
    // in the namespace. Vite/esbuild normalizes the module, so a browser e2e
    // test does not catch this (`@datatablex/fastify` uses the same
    // `default ?? mod` pattern).
    const mod: unknown = await import("exceljs");
    ExcelJS = ((mod as { default?: typeof import("exceljs") }).default ?? mod) as typeof import("exceljs");
  } catch (cause) {
    // We end up here if the package is not installed or if the chunk could not
    // be loaded over the network (offline, a stale cache after a deployment).
    throw new Error("[datatablex] `exceljs` could not be loaded for the Excel export. If the package is not installed, run `npm install exceljs` (optional peer); if it is installed, check the network connection.", {
      cause,
    });
  }
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Export");
  worksheet.addRow(columns.map((column) => column.title));
  // A custom `ExportColumn` can also be passed: an object value would become a formula or link cell in ExcelJS.
  for (const row of rows) worksheet.addRow(columns.map((column) => normalizeExportCell(column.value(row))));
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { type: EXCEL_MIME });
}

/**
 * Excel exporter: produces an `.xlsx` file with a single sheet whose first row
 * holds the column titles. `exceljs` is an **optional peer** dependency of
 * this package: only a consumer that imports this subpath installs it. The
 * library is loaded with a dynamic `import()`; the bundler splits it into a
 * separate chunk, and it is not downloaded until the first Excel export.
 *
 * @example
 * ```ts
 * import { excelExporter } from "@datatablex/react/excel";
 *
 * const table = useDataTable({
 *   columns,
 *   dataSource,
 *   exporters: [excelExporter],
 * });
 * ```
 *
 * @throws {Error} From `build`, when `exceljs` cannot be loaded.
 */
export const excelExporter: DocumentExporter = {
  format: "excel",
  extension: "xlsx",
  mimeType: EXCEL_MIME,
  description: "Excel",
  build: (columns, rows) => excelBlob(columns, rows),
};
