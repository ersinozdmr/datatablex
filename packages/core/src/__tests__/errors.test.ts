import { describe, expect, it } from "vitest";
import { DATA_TABLE_ERROR_CODES, dataTableErrorCode, isDataTableErrorBody, isDataTableErrorCode } from "../index.js";

describe("error contract", () => {
  it("recognizes known codes and rejects unknown ones", () => {
    for (const code of DATA_TABLE_ERROR_CODES) expect(isDataTableErrorCode(code)).toBe(true);
    expect(isDataTableErrorCode("FST_ERR_CTP_INVALID_MEDIA_TYPE")).toBe(false);
    expect(isDataTableErrorCode(undefined)).toBe(false);
  });

  it("a body needs only `message`; it is valid even when `code` is unknown", () => {
    expect(isDataTableErrorBody({ message: "x" })).toBe(true);
    expect(isDataTableErrorBody({ message: "x", code: "new_code", error: "Bad Request" })).toBe(true);
    expect(isDataTableErrorBody({ error: "x" })).toBe(false);
    expect(isDataTableErrorBody(null)).toBe(false);
  });

  it("dataTableErrorCode reads structurally from an error or a body; an unknown code gives `undefined`", () => {
    expect(dataTableErrorCode({ code: "export_busy" })).toBe("export_busy");
    expect(dataTableErrorCode(Object.assign(new Error("x"), { code: "forbidden" }))).toBe("forbidden");
    expect(dataTableErrorCode({ code: "FST_ERR_X" })).toBeUndefined();
    expect(dataTableErrorCode("forbidden")).toBeUndefined();
    expect(dataTableErrorCode(null)).toBeUndefined();
  });
});
