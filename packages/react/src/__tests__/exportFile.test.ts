import { describe, expect, it, vi } from "vitest";
import { csvContent, exportColumnsFor, startDownload } from "../export/exportFile.js";
import type { ColumnState, ReactDataTableColumn } from "../types.js";

interface Row {
  id: number;
  name: string;
  secret: string;
  createdAt: Date;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID" },
  { key: "name", title: "Name", exportValue: (row) => row.name },
  { key: "secret", title: "Secret", exportable: false },
  { key: "createdAt", title: "Screen Date", exportTitle: "Date" },
];

const state: ColumnState[] = [
  { key: "secret", order: 0 },
  { key: "name", order: 1 },
  { key: "id", order: 2, hidden: true },
  { key: "createdAt", order: 3 },
];

describe("export file helpers", () => {
  it("follows the visible order of the column state and leaves out exportable:false fields", () => {
    const resolved = exportColumnsFor(columns, state);
    expect(resolved.map((column) => column.title)).toEqual(["Name", "Date"]);
    expect(resolved.map((column) => column.value({ id: 1, name: "Ada", secret: "x", createdAt: new Date("2026-01-02T03:04:05.000Z") }))).toEqual([
      "Ada",
      new Date("2026-01-02T03:04:05.000Z"),
    ]);
  });

  it("null/0/false/empty string returned by exportValue does not fall back to the raw value", () => {
    const state: ColumnState[] = ["a", "b", "c", "d"].map((key, order) => ({ key, order }));
    const record = { a: "raw-a", b: 7, c: true, d: "raw-d" };
    const resolved = exportColumnsFor<typeof record>(
      [
        { key: "a", title: "A", exportValue: () => null },
        { key: "b", title: "B", exportValue: () => 0 },
        { key: "c", title: "C", exportValue: () => false },
        { key: "d", title: "D", exportValue: () => "" },
      ],
      state,
    );
    expect(resolved.map((column) => column.value(record))).toEqual([null, 0, false, ""]);
    expect(csvContent(resolved, [record])).toBe('\uFEFF"A","B","C","D"\r\n"","0","false",""\r\n');
  });

  it("produces CSV with a BOM, RFC 4180 quoting and formula injection protection", () => {
    const content = csvContent(
      [
        { key: "name", title: "İsim", value: (row: Row) => row.name },
        { key: "date", title: "Date", value: (row: Row) => row.createdAt },
      ],
      [{ id: 1, name: '=cmd|" /C calc"', secret: "x", createdAt: new Date("2026-01-02T03:04:05.000Z") }],
      ";",
    );
    expect(content).toBe('\uFEFF"İsim";"Date"\r\n"\'=cmd|"" /C calc""";"2026-01-02T03:04:05.000Z"\r\n');
  });

  it("negative numbers stay numbers in CSV; text in a number column is left without a prefix, text in a text column is prefixed", () => {
    interface Money {
      amount: number;
      balance: string;
      note: string;
      code: string;
    }
    const resolved = exportColumnsFor<Money>(
      [
        { key: "amount", title: "Amount", type: "number" },
        { key: "balance", title: "Balance", type: "currency" },
        { key: "note", title: "Note", type: "text" },
        { key: "code", title: "Code", type: "number" },
      ],
      ["amount", "balance", "note", "code"].map((key, order) => ({ key, order })),
    );
    const content = csvContent(resolved, [{ amount: -5, balance: "-12.50", note: "-12.50", code: "-5+3" }]);
    expect(content).toBe(`\uFEFF"Amount","Balance","Note","Code"\r\n"-5","-12.50","'-12.50","'-5+3"\r\n`);
  });

  it("startDownload clicks the link through a hidden <a download> and removes it from the document", () => {
    const clicked: Array<{ href: string; download: string; attached: boolean }> = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href")!, download: this.download, attached: document.body.contains(this) });
    });
    try {
      startDownload("/api/x/export/download?ticket=abc", "geçişler.xlsx");
    } finally {
      click.mockRestore();
    }
    expect(clicked).toEqual([{ href: "/api/x/export/download?ticket=abc", download: "geçişler.xlsx", attached: true }]);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });
});
