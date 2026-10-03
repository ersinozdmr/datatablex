import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import ExcelJS from "exceljs";
import { isDataTableEndpointMeta } from "@datatablex/core";
import { datatableRoute } from "../datatableRoute.js";
import { assertValidEndpointConfig } from "../config.js";
import { describeDataTableEndpoint } from "../describe.js";
import { openDataTableExport, validateDataTableExportRequest } from "../export.js";
import { xlsxCellValue } from "../exportWriters/xlsx.js";
import type { DataTableEndpointConfig, DataTableExportConfig } from "../types.js";
import type { RecordedQuery, TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

type Config = DataTableEndpointConfig<TestDB, "access_logs">;

/** Roboto (Apache 2.0), a font with Turkish characters, used by the PDF tests. */
const FONT = fileURLToPath(new URL("./fixtures/fonts/Roboto-Regular.ttf", import.meta.url));

function config(exportConfig: DataTableExportConfig = {}): Config {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"], sortable: true },
      stadiumName: { column: "stadium_name", type: "text", sortable: true, filterOperators: ["contains"], searchable: true },
      // The fake driver returns rows keyed by field name; the column mapping only affects the SQL text.
      price: { column: "status", type: "number" },
      visitDay: { column: "access_date", type: "date" },
      active: { column: "active", type: "boolean" },
    },
    getContext: () => ({ userId: "u1", roles: [] }),
    authorize: () => true,
    export: { formats: ["csv", "excel", "pdf"], pdf: { font: { regular: FONT } }, ...exportConfig },
  };
}

const rows = [
  { id: 1, stadiumName: "Şükrü Saracoğlu", price: "12.50", visitDay: "2025-01-15", active: true },
  { id: 2, stadiumName: '=HYPERLINK("x")', price: "400", visitDay: null, active: false },
  { id: 3, stadiumName: "Ali Sami Yen", price: null, visitDay: "2025-02-01", active: true },
];

function source(streamRows: Array<Record<string, unknown>> = rows, total = streamRows.length) {
  return fakeExecutableDb((q: RecordedQuery) => (/count\(\*\)/.test(q.sql) ? [{ total: String(total) }] : []), { stream: () => streamRows });
}

const columns = [
  { field: "id", title: "No" },
  { field: "stadiumName", title: "Stadium" },
  { field: "price", title: "Price" },
  { field: "visitDay", title: "Gün" },
  { field: "active", title: "Active" },
];

const body = (overrides: Record<string, unknown> = {}) => ({
  query: { sorting: [{ field: "id", direction: "asc" }], filters: null },
  format: "csv",
  columns,
  filename: "geçişler",
  ...overrides,
});

async function app(cfg: Config, db = source().db) {
  const server = Fastify();
  const handler = datatableRoute(db, cfg);
  server.post("/q/export/ticket", handler.exportTicket);
  server.get("/q/export/download", handler.exportDownload);
  await server.ready();
  return server;
}

/** Ticket + download flow; if the ticket is rejected that response (400/413 ...) is returned, otherwise the file response. */
async function runExport(server: Awaited<ReturnType<typeof app>>, request: { payload: object }) {
  const issued = await server.inject({ method: "POST", url: "/q/export/ticket", payload: request.payload });
  if (issued.statusCode !== 200) return issued;
  return server.inject({ method: "GET", url: `/q/export/download?ticket=${encodeURIComponent(issued.json().ticket)}` });
}

const exportBody = (format: string, overrides: Record<string, unknown> = {}) => ({
  method: "POST" as const,
  url: "/q/export",
  payload: body({ format, ...overrides }),
});

describe("export formats — boot rules", () => {
  it("formats must contain known, unique, non-empty formats", () => {
    expect(() => assertValidEndpointConfig(config({ formats: ["xlsx" as never] }))).toThrow(/unknown format/);
    expect(() => assertValidEndpointConfig(config({ formats: ["csv", "csv"] }))).toThrow(/more than once/);
    expect(() => assertValidEndpointConfig(config({ formats: [] }))).toThrow(/at least one format/);
  });

  it("maxRows can be given per format; the Excel sheet ceiling cannot be exceeded", () => {
    expect(() => assertValidEndpointConfig(config({ maxRows: { csv: 10, xlsx: 5 } as never }))).toThrow(/unknown format key/);
    expect(() => assertValidEndpointConfig(config({ maxRows: { excel: 1_048_576 } }))).toThrow(/maxRows\.excel can be at most 1048575/);
    expect(() => assertValidEndpointConfig(config({ maxRows: { pdf: 0 } }))).toThrow(/maxRows\.pdf must be a positive/);
    expect(() => assertValidEndpointConfig(config({ maxRows: { excel: 1_048_575 } }))).not.toThrow();
    expect(() => assertValidEndpointConfig(config({ maxSelectedKeys: 0 }))).toThrow(/maxSelectedKeys/);
  });

  it("pdf requires a font with Turkish characters", () => {
    expect(() => assertValidEndpointConfig(config({ pdf: undefined }))).toThrow(/pdf\.font\.regular is missing/);
    expect(() => assertValidEndpointConfig(config({ pdf: { font: { regular: "" } } }))).toThrow(/pdf\.font\.regular is missing/);
    expect(() => assertValidEndpointConfig(config({ pdf: { font: { regular: new Uint8Array(readFileSync(FONT)) } } }))).not.toThrow();
    // No font is needed when PDF is disabled.
    expect(() => assertValidEndpointConfig(config({ formats: ["csv", "excel"], pdf: undefined }))).not.toThrow();
  });
});

describe("export formats — meta", () => {
  it("formats reports the enabled formats and their row ceilings in a single field", () => {
    const meta = describeDataTableEndpoint(config({ maxRows: { csv: 10, excel: 5 } }));
    expect(meta.export).toEqual({ formats: { csv: 10, excel: 5, pdf: 100_000 }, fields: ["id", "stadiumName", "price", "visitDay", "active"] });
    expect(isDataTableEndpointMeta(meta)).toBe(true);
  });

  it("the formats key has no csv entry when CSV is disabled", () => {
    const meta = describeDataTableEndpoint(config({ formats: ["excel", "pdf"], maxRows: { excel: 7, pdf: 3 } }));
    expect(meta.export).toEqual({ formats: { excel: 7, pdf: 3 }, fields: expect.any(Array) });
    expect(isDataTableEndpointMeta(meta)).toBe(true);
  });
});

describe("export formats — route", () => {
  it("a format not enabled on the endpoint gets 400", async () => {
    const server = await app(config({ formats: ["csv"], pdf: undefined }));
    const response = await runExport(server, exportBody("excel"));
    expect(response.statusCode).toBe(400);
    expect(response.json().details[0].path).toEqual(["format"]);
  });

  it("XLSX: typed cells, bold header, no formula injection", async () => {
    const server = await app(config());
    const response = await runExport(server, exportBody("excel"));
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers["content-disposition"]).toContain("filename*=UTF-8''ge%C3%A7i%C5%9Fler.xlsx");
    expect(response.headers["x-datatablex-total"]).toBe("3");

    const workbook = new ExcelJS.Workbook();
    // The exceljs types expect Node's older `Buffer` definition.
    await workbook.xlsx.load(response.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet("Export")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "No", "Stadium", "Price", "Gün", "Active"]);
    expect(sheet.getRow(1).font?.bold).toBe(true);
    expect(sheet.rowCount).toBe(4);
    const first = sheet.getRow(2);
    expect(first.getCell(1).value).toBe(1);
    expect(first.getCell(2).value).toBe("Şükrü Saracoğlu");
    // PostgreSQL returns `numeric` as text; it must be a number in Excel.
    expect(first.getCell(3).value).toBe(12.5);
    // `date` is UTC midnight: the day does not shift.
    expect(first.getCell(4).value).toEqual(new Date(Date.UTC(2025, 0, 15)));
    expect(first.getCell(4).numFmt).toBe("yyyy-mm-dd");
    expect(first.getCell(5).value).toBe(true);
    const injected = sheet.getRow(3).getCell(2);
    expect(injected.value).toBe('=HYPERLINK("x")');
    expect(injected.formula).toBeUndefined();
    expect(sheet.getRow(3).getCell(4).value).toBeNull();
  });

  it("XLSX: an object returned by the formatter is not written as a formula", () => {
    expect(xlsxCellValue({ formula: "1+1" }, "text")).toBe("[object Object]");
    expect(xlsxCellValue("x".repeat(40_000), "text")).toHaveLength(32_767);
    expect(xlsxCellValue("12a", "number")).toBe("12a");
    expect(xlsxCellValue(new Date(Number.NaN), "datetime")).toBeNull();
  });

  it("XLSX: a PostgreSQL bigint/numeric value is not converted to a number if precision would be lost", () => {
    expect(xlsxCellValue("12.50", "number")).toBe(12.5);
    expect(xlsxCellValue("-5", "number")).toBe(-5);
    expect(xlsxCellValue("123456789012345", "number")).toBe(123456789012345);
    // A 16-digit but safe integer is shown exactly; beyond MAX_SAFE_INTEGER it stays text.
    expect(xlsxCellValue("9007199254740991", "number")).toBe(9007199254740991);
    expect(xlsxCellValue("9007199254740993", "number")).toBe("9007199254740993");
    expect(xlsxCellValue("-9007199254740993", "number")).toBe("-9007199254740993");
    expect(xlsxCellValue("0.1234567890123456789", "number")).toBe("0.1234567890123456789");
    expect(xlsxCellValue("9".repeat(400), "number")).toBe("9".repeat(400));
    expect(xlsxCellValue(10n ** 20n, "number")).toBe("100000000000000000000");
    // A text field is not converted to a number even if it looks like one.
    expect(xlsxCellValue("42", "text")).toBe("42");
  });

  it("CSV: a negative number field, and a numeric arriving as text, is not prefixed; a text field is", async () => {
    const { createCsvWriter } = await import("../exportWriters/csv.js");
    const writer = createCsvWriter([
      { field: "amount", title: "Amount", type: "number" },
      { field: "note", title: "Note", type: "text" },
    ]);
    const chunks: string[] = [];
    writer.out.on("data", (chunk) => chunks.push(String(chunk)));
    writer.writeRow(["-12.50", "-12.50"]);
    writer.writeRow([-3, "=1+1"]);
    await writer.end();
    await new Promise((resolve) => writer.out.on("end", resolve));
    const body = chunks.join("");
    expect(body).toContain(`"-12.50","'-12.50"`);
    expect(body).toContain(`"-3","'=1+1"`);
  });

  it("PDF: a valid multi-page document with a title", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, stadiumName: `Şükrü Saracoğlu ${i + 1}`, price: "10", visitDay: "2025-01-15", active: true }));
    const server = await app(config(), source(many).db);
    const response = await runExport(server, exportBody("pdf", { title: "Geçişler" }));
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toContain(".pdf");
    const pdf = response.rawPayload.toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    const pages = Number(/\/Type \/Pages[\s\S]*?\/Count (\d+)/.exec(pdf)?.[1]);
    // 5 columns: landscape A4, about 40 rows per page.
    expect(pages).toBeGreaterThan(5);
    expect(pages).toBeLessThan(15);
  });

  it("maxRows is applied per format", async () => {
    const server = await app(config({ maxRows: { csv: 10, excel: 2 } }));
    expect((await runExport(server, exportBody("excel"))).statusCode).toBe(413);
    expect((await runExport(server, exportBody("csv"))).statusCode).toBe(200);
  });
});

describe("PDF writer — font layout cache", () => {
  it("the embedded font word cache is cleared per page; it does not grow with non-repeating text", async () => {
    const { createPdfWriter } = await import("../exportWriters/pdf.js");
    const writer = await createPdfWriter(
      [
        { field: "id", title: "No", type: "number" },
        { field: "note", title: "Note", type: "text" },
      ],
      { title: "Cache", pdfFont: { regular: FONT } },
    );
    writer.out.resume();
    // Two non-repeating words per row: without clearing the cache there would be about 2,400 keys (~20 pages).
    for (let i = 0; i < 1_200; i++) writer.writeRow([i, `record-${i} note-${i * 7919}`]);
    const families = (writer.out as unknown as { _fontFamilies: Record<string, { layoutCache?: Record<string, unknown> }> })._fontFamilies;
    const cached = Object.values(families).map((font) => Object.keys(font.layoutCache ?? {}).length);
    // About 60 rows per page on portrait A4.
    expect(Math.max(...cached)).toBeLessThan(500);
    await writer.end();
    // Synchronous PDF writing is CPU-bound: with parallel package tests in CI it can exceed the 5 s default.
  }, 15_000);
});

describe("export scopes", () => {
  it("currentPage: same query with the page's LIMIT/OFFSET; the total is that page's rows", async () => {
    const { db, calls } = source(rows.slice(0, 2), 5);
    const server = await app(config(), db);
    const response = await runExport(server, exportBody("csv", { scope: "currentPage", query: { sorting: [], filters: null, pagination: { page: 2, pageSize: 2 } } }));
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-datatablex-total"]).toBe("2");
    const streamed = calls.at(-1)!;
    expect(streamed.sql).toMatch(/limit \$\d+ offset \$\d+$/);
    expect(streamed.parameters.slice(-2)).toEqual([2, 2]);
  });

  it("currentPage: the last page's total is the remaining rows; pagination is required", async () => {
    const server = await app(config(), source(rows, 5).db);
    const last = await runExport(server, exportBody("csv", { scope: "currentPage", query: { sorting: [], filters: null, pagination: { page: 3, pageSize: 2 } } }));
    expect(last.headers["x-datatablex-total"]).toBe("1");
    const missing = await runExport(server, exportBody("csv", { scope: "currentPage" }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().details[0].path).toEqual(["query", "pagination"]);
  });

  it("selected: primary key `in` filter; the client's filter and search are ignored", async () => {
    const { db, calls } = source();
    const onExport = vi.fn();
    const server = await app(config({ onExport }), db);
    const response = await runExport(server, exportBody("csv", {
        scope: "selected",
        keys: [3, 1, 3],
        query: { sorting: [], filters: { operator: "AND", filters: [{ field: "stadiumName", operator: "contains", value: "zzz" }] }, search: "zzz" },
      }),
    );
    expect(response.statusCode).toBe(200);
    const count = calls.find((q) => /count\(\*\)/.test(q.sql))!;
    expect(count.sql).toContain('"id" in ($1, $2)');
    expect(count.sql).not.toContain("ilike");
    expect(count.parameters).toEqual([3, 1]);
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(onExport.mock.calls[0]![0]).toMatchObject({
      format: "csv",
      scope: "selected",
      query: { filters: { operator: "AND", filters: [{ field: "id", operator: "in", value: [3, 1] }] } },
    });
  });

  it("selected: keys is required, of the primary key's type and limited by maxSelectedKeys; keys is rejected in other scopes", async () => {
    const server = await app(config({ maxSelectedKeys: 2 }));
    const paths = async (overrides: Record<string, unknown>) => {
      const response = await runExport(server, exportBody("csv", overrides));
      expect(response.statusCode).toBe(400);
      return response.json().details.map((d: { path: unknown[] }) => d.path);
    };
    expect(await paths({ scope: "selected" })).toContainEqual(["keys"]);
    expect(await paths({ scope: "selected", keys: ["x"] })).toContainEqual(["keys", 0]);
    expect(await paths({ scope: "selected", keys: [1, 2, 3] })).toContainEqual(["keys"]);
    expect(await paths({ scope: "allFiltered", keys: [1] })).toContainEqual(["keys"]);
  });
});

describe("export — backpressure", () => {
  // Poorly compressible text: repeating text shrinks in the zip and would make the buffered amount look smaller than it is.
  const noise = (i: number) => Array.from({ length: 8 }, (_, k) => (((i + 1) * (k + 7919) * 2654435761) % 4294967296).toString(36)).join(" ");
  const many = Array.from({ length: 60_000 }, (_, i) => ({ id: i + 1, stadiumName: `Stadium ${i} ${noise(i)}`, price: "10", visitDay: "2025-01-15", active: true }));

  it.each(["csv", "excel", "pdf"] as const)("%s: an unread body stops reading from the database; it is cancelled when abandoned", async (format) => {
    const { db, events, streamed } = source(many);
    const onExport = vi.fn();
    const cfg = config({ onExport, batchSize: 100 });
    const opened = await openDataTableExport(db, cfg, validateDataTableExportRequest(body({ format }), cfg), { userId: "u1", roles: [] });

    const reader = opened.body[Symbol.asyncIterator]();
    await reader.next();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // While the consumer does not read, the producer gets ahead by at most a buffer of a few hundred KB (measured: 2-4 thousand rows).
    expect(streamed.rows).toBeLessThan(10_000);

    await reader.return?.();
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(onExport.mock.calls[0]![0].outcome).toBe("cancelled");
    expect(events.at(-1)).toBe("rollback");
    // PDF alone takes about 2 s; while all packages are built and tested in parallel the 5 s default may not be enough.
  }, 30_000);
});
