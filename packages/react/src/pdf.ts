import type { DocumentExporter } from "./export/exporter.js";
import type { ExportCell } from "./export/cell.js";
import type { ExportColumn } from "./export/exportFile.js";

/** Converts a cell to the text written to the PDF. */
function pdfCell(value: ExportCell): string {
  if (value === null || value === undefined) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

interface PdfMakeBrowser {
  addVirtualFileSystem: (vfs: Record<string, string>) => void;
  createPdf: (documentDefinition: unknown) => { getBlob: (callback: (blob: Blob) => void) => void };
}

/**
 * Builds the PDF. The table rows are split across pages; with four or fewer
 * columns the page is portrait A4, with more it is landscape A4.
 */
async function pdfBlob<T>(columns: ExportColumn<T>[], rows: T[], title: string): Promise<Blob> {
  let pdfMake: PdfMakeBrowser;
  let vfs: Record<string, string>;
  try {
    const [pdfMakeModule, vfsModule] = await Promise.all([
      import("pdfmake/build/pdfmake.js"),
      import("pdfmake/build/vfs_fonts.js"),
    ]);
    pdfMake = pdfMakeModule.default as unknown as PdfMakeBrowser;
    vfs = vfsModule.default as Record<string, string>;
  } catch (cause) {
    throw new Error("[datatablex] `pdfmake` could not be loaded for the PDF export. If the package is not installed, run `npm install pdfmake` (optional peer); if it is installed, check the network connection.", {
      cause,
    });
  }

  pdfMake.addVirtualFileSystem(vfs);
  const documentDefinition = {
    info: { title },
    pageSize: "A4",
    pageOrientation: columns.length > 4 ? "landscape" : "portrait",
    pageMargins: [24, 32, 24, 32],
    defaultStyle: { font: "Roboto", fontSize: 8 },
    content: [
      { text: title, fontSize: 14, bold: true, margin: [0, 0, 0, 12] },
      {
        table: {
          headerRows: 1,
          widths: columns.map(() => "*"),
          body: [
            columns.map((column) => ({ text: column.title, bold: true })),
            ...rows.map((row) => columns.map((column) => pdfCell(column.value(row)))),
          ],
        },
        layout: "lightHorizontalLines",
      },
    ],
  };

  return new Promise<Blob>((resolve, reject) => {
    try {
      pdfMake.createPdf(documentDefinition).getBlob(resolve);
    } catch (cause) {
      reject(cause);
    }
  });
}

/**
 * PDF exporter: produces a PDF document with a title and a table of the
 * rows; the title comes from `exportData(..., { title })`. `pdfmake` is an
 * **optional peer** dependency of this package: only a consumer that imports
 * this subpath installs it. The library and the embedded Roboto font (which
 * covers Turkish characters, among others) are loaded with a dynamic
 * `import()`.
 *
 * @example
 * ```ts
 * import { pdfExporter } from "@datatablex/react/pdf";
 *
 * const table = useDataTable({
 *   columns,
 *   dataSource,
 *   exporters: [pdfExporter],
 * });
 * await table.exportData("pdf", "allFiltered", { title: "Orders" });
 * ```
 *
 * @throws {Error} From `build`, when `pdfmake` cannot be loaded.
 */
export const pdfExporter: DocumentExporter = {
  format: "pdf",
  extension: "pdf",
  mimeType: "application/pdf",
  description: "PDF",
  build: (columns, rows, { title }) => pdfBlob(columns, rows, title),
};
