import type { FieldType } from "../types.js";
import type { ExportColumnSpec, ExportWriter } from "./types.js";
import { WRITER_HIGH_WATER_MARK } from "./types.js";
import { createOutput } from "./passThrough.js";
import { loadExcelJS } from "./packages.js";

/** Excel's per-cell character limit; longer text makes the file open with a "repair" warning. */
const EXCEL_MAX_CELL_CHARS = 32_767;

const NUMBER_FORMAT: Partial<Record<FieldType, string>> = {
  date: "yyyy-mm-dd",
  datetime: "yyyy-mm-dd hh:mm:ss",
};

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

/**
 * Converts text holding a number literal to a `number` WITHOUT CHANGING ITS
 * VALUE; if that is not possible it returns `null` (the cell stays text). A
 * double-precision number keeps at most 15 significant decimal digits, and
 * PostgreSQL `bigint`/`numeric` can be longer than that (`"9007199254740993"`
 * would silently become `...992`, and 400 digits would become `Infinity`). Safe
 * integers (up to 16 digits) can be represented exactly.
 */
function exactNumber(text: string): number | null {
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const significant = text.replace(/^-/, "").replace(".", "").replace(/^0+(?=\d)/, "");
  if (significant.length <= 15) return n;
  return !text.includes(".") && Number.isSafeInteger(n) ? n : null;
}
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Cell value. Numbers, dates and booleans are written typed, so they can be
 * sorted and summed in Excel. PostgreSQL `numeric`/`bigint` (only when no value
 * is lost; see `exactNumber`) and `date` columns that come back as text are
 * converted too. A `date` is UTC midnight: `exceljs` writes dates in UTC, and
 * local midnight would shift the day.
 *
 * Objects (other than Date) are converted to text: `exceljs` writes an object
 * shaped like `{ formula }`, `{ richText }` or `{ hyperlink }` as a formula or
 * link, and such a value coming from `formatter` would be formula injection.
 * Plain text is never treated as a formula, so the `'` prefix used in CSV is
 * not needed here.
 */
export function xlsxCellValue(value: unknown, type: FieldType): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  const text = typeof value === "string" ? value : String(value);
  if (type === "number" && NUMERIC_STRING.test(text)) {
    const exact = exactNumber(text);
    if (exact !== null) return exact;
  }
  if (type === "date") {
    const match = DATE_ONLY.exec(text);
    if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  return text.length > EXCEL_MAX_CELL_CHARS ? text.slice(0, EXCEL_MAX_CELL_CHARS) : text;
}

/**
 * Internal streams of `exceljs` and `archiver`. `archiver` uses an old version
 * of `readable-stream` that has no `readableLength`/`writableLength` getters, so
 * the lengths are read from the internal state objects.
 */
interface LegacyStream {
  _readableState?: { length?: number };
  _writableState?: { length?: number };
}
interface SheetStreamInternals {
  buffers?: unknown[];
  bufSize?: number;
  pipes?: LegacyStream[];
}

const buffered = (stream: LegacyStream | undefined) => (stream?._readableState?.length ?? 0) + (stream?._writableState?.length ?? 0);

/**
 * Streaming XLSX writer built on the `exceljs` stream writer: each row is
 * written to the zip stream with `commit()` and dropped from memory;
 * `useSharedStrings: false` embeds the text in the cell (a shared string table
 * would stay in memory until the file is finished).
 *
 * Backpressure: `exceljs` passes the sheet XML from its own buffer
 * (`StreamBuf`) to `archiver` without checking whether `archiver` is full. When
 * the output is full, `archiver` stops, but the data it has compressed piles up
 * in its own readable buffer; a check that only looks at the output does not see
 * this. `pendingBytes` counts the intermediate buffers too. The fields are
 * internals; if a version drops them, the check falls back to the output alone
 * (the backpressure test catches this).
 */
export async function createXlsxWriter(columns: ExportColumnSpec[]): Promise<ExportWriter> {
  const ExcelJS = await loadExcelJS();
  const { out, congested } = createOutput();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  const sheet = workbook.addWorksheet("Export", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map((column) => {
    const numFmt = NUMBER_FORMAT[column.type];
    return {
      header: column.title,
      key: column.field,
      width: Math.min(50, Math.max(12, column.title.length + 4)),
      ...(numFmt ? { style: { numFmt } } : null),
    };
  });
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.commit();

  const zip = (workbook as unknown as { zip?: LegacyStream }).zip;
  const sheetStream = (sheet as unknown as { stream?: SheetStreamInternals }).stream;
  const pendingBytes = () => {
    const sheetBuffered = (sheetStream?.buffers?.length ?? 0) * (sheetStream?.bufSize ?? 0);
    const compressing = sheetStream?.pipes?.reduce((sum, pipe) => sum + buffered(pipe), 0) ?? 0;
    return sheetBuffered + compressing + buffered(zip);
  };

  let aborted = false;
  return {
    out,
    congested: () => congested() || pendingBytes() >= WRITER_HIGH_WATER_MARK,
    writeRow(values) {
      sheet.addRow(values.map((value, index) => xlsxCellValue(value, columns[index]!.type))).commit();
    },
    async end() {
      sheet.commit();
      await workbook.commit();
    },
    abort(error) {
      if (aborted) return;
      aborted = true;
      out.destroy(error instanceof Error ? error : undefined);
    },
  };
}
