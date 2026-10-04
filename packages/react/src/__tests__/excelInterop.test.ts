// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

/**
 * Node's ESM loader exposes the CommonJS `exceljs` as `{ default: module.exports }`;
 * `Workbook` is not on the namespace, and `new ExcelJS.Workbook()` throws "is not a constructor".
 * Vitest/Vite normalizes the module, so we imitate that behavior here.
 */
vi.mock("exceljs", async () => {
  const actual = (await vi.importActual<{ default?: object }>("exceljs"));
  return { default: actual.default ?? actual };
});

describe("/excel — ExcelJS CJS/ESM interop", () => {
  it("also works with a module namespace that only has `default`", async () => {
    const { excelExporter } = await import("../excel.js");
    const ExcelJS = (await import("exceljs")) as unknown as { default: typeof import("exceljs") };

    const blob = await excelExporter.build([{ key: "a", title: "A", value: (row: { a: number }) => row.a }], [{ a: 7 }], { title: "t" });
    const workbook = new ExcelJS.default.Workbook();
    await workbook.xlsx.load((await blob.arrayBuffer()) as never);
    expect(workbook.getWorksheet("Export")!.getRow(2).getCell(1).value).toBe(7);
  });
});
