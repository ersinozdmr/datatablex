import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "../csv.js";

describe("csv", () => {
  it("quotes the cell, doubles inner quotes, writes null as empty and Date as ISO", () => {
    expect(csvCell('a "b"')).toBe('"a ""b"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(12.5)).toBe('"12.5"');
    expect(csvCell(false)).toBe('"false"');
    expect(csvCell(new Date("2026-09-27T10:00:00.000Z"))).toBe('"2026-09-27T10:00:00.000Z"');
  });

  it("turns formula prefixes into literal text (CWE-1236)", () => {
    for (const text of ["=1+1", "+90", "-5", "@SUM(A1)", "\tx", "\rx"]) {
      expect(csvCell(text)).toBe(`"'${text}"`);
    }
  });

  it("does not prefix a real number, bigint or boolean; a negative number stays a number", () => {
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(-12.5)).toBe('"-12.5"');
    expect(csvCell(-9007199254740993n)).toBe('"-9007199254740993"');
    expect(csvCell(true)).toBe('"true"');
    // The text "-5" is still prefixed: text of unknown origin could be a formula.
    expect(csvCell("-5")).toBe(`"'-5"`);
  });

  it("with numeric: true, plain number literal text is not prefixed; text that does not look like a number is", () => {
    expect(csvCell("-12.50", true)).toBe('"-12.50"');
    expect(csvCell("-9007199254740993", true)).toBe('"-9007199254740993"');
    expect(csvCell("-5+3", true)).toBe(`"'-5+3"`);
    expect(csvCell("=1+1", true)).toBe(`"'=1+1"`);
    expect(csvCell("-1e3", true)).toBe(`"'-1e3"`);
    expect(csvCell("-12.50")).toBe(`"'-12.50"`);
  });

  it("csvRow applies numericColumns in column order", () => {
    expect(csvRow(["-1.5", "-1.5", -2], ",", [true, false, false])).toBe(`"-1.5","'-1.5","-2"`);
    // `map(csvCell)` must not pass the index as the second argument.
    expect(csvRow(["-1", "-1"])).toBe(`"'-1","'-1"`);
  });

  it("joins the cells with the delimiter", () => {
    expect(csvRow(["a", 1, null])).toBe('"a","1",""');
    expect(csvRow(["a", "b"], ";")).toBe('"a";"b"');
  });
});
