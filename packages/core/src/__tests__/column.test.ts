import { describe, expect, it } from "vitest";
import { columnField, columnValue } from "../column.js";

describe("columnField / columnValue", () => {
  const row = { id: 1, code: "111", codeMasked: "**1", first: "Ada", last: "Smith" };

  it("falls back to key when field is absent; an explicit null is kept", () => {
    expect(columnField({ key: "code" })).toBe("code");
    expect(columnField({ key: "codeColumn", field: "code" })).toBe("code");
    expect(columnField({ key: "fullName", field: null })).toBeNull();
  });

  it("value precedence: accessor function > accessor field > field > key", () => {
    expect(columnValue({ key: "x", accessor: (r: typeof row) => `${r.first} ${r.last}` }, row)).toBe("Ada Smith");
    expect(columnValue({ key: "codeColumn", field: "code", accessor: "codeMasked" }, row)).toBe("**1");
    expect(columnValue({ key: "codeColumn", field: "code" }, row)).toBe("111");
    expect(columnValue({ key: "id" }, row)).toBe(1);
    expect(columnValue({ key: "code", field: null }, row)).toBe("111");
  });
});
