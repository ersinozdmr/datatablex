import type { ExportColumnSpec, ExportWriter, ExportWriterOptions } from "./types.js";
import { WRITER_HIGH_WATER_MARK } from "./types.js";
import { loadPdfKit } from "./packages.js";

const REGULAR = "datatablex-regular";
const BOLD = "datatablex-bold";
const FONT_SIZE = 8;
const TITLE_SIZE = 14;
const PADDING = 2;
/** Cell text wraps onto at most this many lines; anything beyond that is cut with `…`. */
const MAX_LINES = 3;
/** Upper limit on measured text: measuring text too long to fit in three lines is wasted work. */
const MAX_MEASURED_CHARS = 2000;
const FOOTER_SPACE = 14;

/** Converts a cell value to the text drawn in the PDF: `null`/`undefined` and invalid dates become an empty string, dates become ISO strings, and long text is truncated to a measurable length. */
export function pdfCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  const text = String(value);
  return text.length > MAX_MEASURED_CHARS ? text.slice(0, MAX_MEASURED_CHARS) : text;
}

/**
 * The embedded font's word layout cache (`EmbeddedFont.layoutCache`) is never
 * emptied: with non-repeating text it grows with the row count (measured: about
 * 3 GB of heap at 100K rows). `fontLayoutCache: false` keeps memory constant but
 * lays out every word again (240 s for 100K rows). Instead the cache is kept on
 * and emptied on every page: repeated words on the same page come from the
 * cache, and memory is bounded by the page (88 s and about 105 MB of heap for
 * 100K rows). The field is an internal of `pdfkit`; it is probed once per
 * process, and if it cannot be found the cache is turned off (slow, but still
 * safe for memory).
 */
interface FontInternals {
  layoutCache?: unknown;
}

function fontFamilies(doc: PDFKit.PDFDocument): Record<string, FontInternals> {
  return (doc as unknown as { _fontFamilies?: Record<string, FontInternals> })._fontFamilies ?? {};
}

let layoutCacheResettable: boolean | null = null;

function probeLayoutCacheReset(PDFDocument: typeof import("pdfkit"), regular: string | Buffer): boolean {
  if (layoutCacheResettable === null) {
    try {
      const probe = new PDFDocument({ autoFirstPage: false });
      probe.registerFont(REGULAR, regular);
      probe.addPage();
      probe.font(REGULAR).widthOfString("datatablex");
      layoutCacheResettable = Object.values(fontFamilies(probe)).some((font) => typeof font.layoutCache === "object" && font.layoutCache !== null);
      probe.destroy();
    } catch {
      layoutCacheResettable = false;
    }
  }
  return layoutCacheResettable;
}

function fontSource(source: string | Uint8Array): string | Buffer {
  return typeof source === "string" ? source : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
}

/**
 * Streaming PDF writer built on `pdfkit`. `pdfmake` is not used because it
 * builds the whole document in memory; `pdfkit` writes each page as soon as it
 * is finished (`bufferPages: false`). The table layout is done here: equal
 * column widths, landscape A4 with more than 4 columns, a header row on every
 * page, and the page number at the bottom. The total page count is not written,
 * because that would require keeping all pages in memory.
 *
 * Row height is estimated from the text width (measuring every cell with word
 * wrapping is expensive); if the estimate falls short, the text is still cut
 * with `…` at the cell height instead of overflowing.
 *
 * @throws {Error} When `options.pdfFont` is missing or the font cannot be registered by `pdfkit`.
 */
export async function createPdfWriter(columns: ExportColumnSpec[], options: ExportWriterOptions): Promise<ExportWriter> {
  const PDFDocument = await loadPdfKit();
  const font = options.pdfFont!;
  const canResetCache = probeLayoutCacheReset(PDFDocument, fontSource(font.regular));
  const doc = new PDFDocument({
    size: "A4",
    layout: columns.length > 4 ? "landscape" : "portrait",
    margins: { top: 32, bottom: 32, left: 24, right: 24 },
    autoFirstPage: false,
    bufferPages: false,
    fontLayoutCache: canResetCache,
    info: { Title: options.title, Creator: "DataTableX" },
  });
  doc.registerFont(REGULAR, fontSource(font.regular));
  doc.registerFont(BOLD, fontSource(font.bold ?? font.regular));

  const resetLayoutCache = () => {
    if (!canResetCache) return;
    for (const font of Object.values(fontFamilies(doc))) {
      if (font.layoutCache) font.layoutCache = Object.create(null);
    }
  };
  let pageNumber = 0;
  let y = 0;
  let left = 0;
  let right = 0;
  let bottom = 0;
  let columnWidth = 0;
  let lineHeight = 0;
  const titles = columns.map((c) => c.title);

  const drawFooter = () => {
    // Writing into the bottom margin makes pdfkit start a new page, so the margin is removed temporarily.
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(REGULAR).fontSize(7).fillColor("#666666");
    doc.text(String(pageNumber), left, doc.page.height - margin + 10, { width: right - left, align: "center", lineBreak: false });
    doc.page.margins.bottom = margin;
    doc.fillColor("#000000");
  };

  const linesFor = (text: string, innerWidth: number) => {
    let lines = 0;
    for (const part of text.split("\n")) {
      lines += Math.max(1, Math.ceil(doc.widthOfString(part) / innerWidth));
      if (lines >= MAX_LINES) return MAX_LINES;
    }
    return lines;
  };

  const drawRow = (texts: string[], fontName: string, isHeader: boolean) => {
    doc.font(fontName).fontSize(FONT_SIZE);
    const innerWidth = columnWidth - 2 * PADDING;
    const lines = Math.max(1, ...texts.map((text) => (text ? linesFor(text, innerWidth) : 1)));
    const height = lines * lineHeight + 2 * PADDING;
    if (!isHeader && y + height > bottom) {
      newPage();
      doc.font(fontName).fontSize(FONT_SIZE);
    }
    texts.forEach((text, index) => {
      if (!text) return;
      doc.text(text, left + index * columnWidth + PADDING, y + PADDING, { width: innerWidth, height: lines * lineHeight, ellipsis: true });
    });
    y += height;
    doc
      .moveTo(left, y)
      .lineTo(right, y)
      .lineWidth(isHeader ? 0.8 : 0.3)
      .strokeColor(isHeader ? "#999999" : "#dddddd")
      .stroke();
  };

  const newPage = () => {
    if (pageNumber > 0) drawFooter();
    resetLayoutCache();
    doc.addPage();
    pageNumber++;
    left = doc.page.margins.left;
    right = doc.page.width - doc.page.margins.right;
    bottom = doc.page.height - doc.page.margins.bottom - FOOTER_SPACE;
    columnWidth = (right - left) / columns.length;
    y = doc.page.margins.top;
    if (pageNumber === 1 && options.title) {
      doc.font(BOLD).fontSize(TITLE_SIZE).text(options.title, left, y, { width: right - left, height: TITLE_SIZE * 1.4, ellipsis: true });
      y += TITLE_SIZE * 1.4 + 8;
    }
    drawRow(titles, BOLD, true);
  };

  doc.font(REGULAR).fontSize(FONT_SIZE);
  lineHeight = doc.currentLineHeight(true);
  newPage();

  let finished = false;
  return {
    out: doc,
    // `pdfkit` pushes without waiting for the consumer; the buffer only empties by being read.
    congested: () => doc.readableLength >= WRITER_HIGH_WATER_MARK,
    writeRow(values) {
      drawRow(values.map(pdfCellText), REGULAR, false);
    },
    async end() {
      drawFooter();
      finished = true;
      doc.end();
    },
    abort(error) {
      if (finished) return;
      finished = true;
      doc.destroy(error instanceof Error ? error : undefined);
    },
  };
}
