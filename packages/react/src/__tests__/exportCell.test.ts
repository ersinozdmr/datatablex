// @vitest-environment node
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { normalizeExportCell } from "../export/cell.js";
import { csvContent, exportColumnsFor } from "../export/exportFile.js";
import { excelExporter } from "../excel.js";
import type { ReactDataTableColumn } from "../types.js";

describe("normalizeExportCell", () => {
  it("leaves ExportCell values as they are", () => {
    const date = new Date("2026-09-29T10:00:00.000Z");
    expect(normalizeExportCell("a")).toBe("a");
    expect(normalizeExportCell(0)).toBe(0);
    expect(normalizeExportCell(-5)).toBe(-5);
    expect(normalizeExportCell(false)).toBe(false);
    expect(normalizeExportCell(date)).toBe(date);
    expect(normalizeExportCell(null)).toBeNull();
    expect(normalizeExportCell(undefined)).toBeNull();
  });

  it("makes non-finite numbers and invalid dates safe; keeps bigint", () => {
    expect(normalizeExportCell(Number.NaN)).toBe("NaN");
    expect(normalizeExportCell(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(normalizeExportCell(new Date(Number.NaN))).toBeNull();
    expect(normalizeExportCell(12n)).toBe(12);
    expect(normalizeExportCell(2n ** 60n)).toBe("1152921504606846976");
  });

  it("an object, array, symbol or function never passes through as an object", () => {
    expect(normalizeExportCell({ formula: "1+1" })).toBe('{"formula":"1+1"}');
    expect(normalizeExportCell({ hyperlink: "http://x", text: "t" })).toBe('{"hyperlink":"http://x","text":"t"}');
    expect(normalizeExportCell({ richText: [{ text: "a" }] })).toBe('{"richText":[{"text":"a"}]}');
    expect(normalizeExportCell([1, "a"])).toBe('[1,"a"]');
    expect(typeof normalizeExportCell(Symbol("s"))).toBe("string");
    expect(typeof normalizeExportCell(() => 1)).toBe("string");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof normalizeExportCell(circular)).toBe("string");
  });
});

interface Row {
  payload: unknown;
  amount: unknown;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "payload", title: "Payload" },
  { key: "amount", title: "Amount", exportValue: (row) => row.amount as number },
];
const rows: Row[] = [{ payload: { formula: 'HYPERLINK("https://evil.invalid","open")' }, amount: { formula: "1+1" } }];
const state = columns.map((column, order) => ({ key: column.key, order }));

describe("exportColumnsFor produces ExportCell at runtime", () => {
  it("an object from a raw accessor or from exportValue is converted to text", () => {
    const resolved = exportColumnsFor(columns, state);
    expect(resolved.map((column) => column.value(rows[0]!))).toEqual(['{"formula":"HYPERLINK(\\"https://evil.invalid\\",\\"open\\")"}', '{"formula":"1+1"}']);
    expect(csvContent(resolved, rows)).toContain('"{""formula"":""1+1""}"');
  });

  it("the Excel output has no formula or hyperlink cell (read back)", async () => {
    const blob = await excelExporter.build(exportColumnsFor(columns, state), rows, { title: "x" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await blob.arrayBuffer()) as never);
    const row = workbook.getWorksheet("Export")!.getRow(2);
    for (const index of [1, 2]) {
      const cell = row.getCell(index);
      expect(cell.formula).toBeUndefined();
      expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
      expect(cell.type).not.toBe(ExcelJS.ValueType.Hyperlink);
      expect(typeof cell.value).toBe("string");
    }
  });
});
