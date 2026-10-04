import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRestDataSource,
  DataTableExportError,
  DataTableRequestError,
  ExportBusyError,
  ExportRowLimitError,
  isDataTableRequestError,
  isExportBusyError,
  isExportRowLimitError,
} from "../index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DataTableRequestError.code", () => {
  it("carries the recognized code from the body, leaves an unknown code or a body without one undefined", () => {
    expect(new DataTableRequestError("x", 429, { message: "x", code: "export_busy" }).code).toBe("export_busy");
    expect(new DataTableRequestError("x", 400, { message: "x", code: "FST_ERR_CTP_BODY_TOO_LARGE" }).code).toBeUndefined();
    expect(new DataTableRequestError("x", 500, null).code).toBeUndefined();
  });

  it("createRestDataSource carries the code of an error response onto the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden", code: "forbidden", message: "Forbidden" }), { status: 403 })),
    );
    const source = createRestDataSource({ endpoint: "/q" });
    const error = await source.fetch({ pagination: { page: 1, pageSize: 10 }, sorting: [], filters: null }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "DataTableRequestError", status: 403, code: "forbidden" });
  });
});

describe("client errors carry a code", () => {
  it("export errors", () => {
    expect(new ExportRowLimitError(2, 1, "server").code).toBe("export_too_large");
    expect(new ExportBusyError(4).code).toBe("export_busy");
    expect(new DataTableExportError("no_rows_selected", "x").code).toBe("no_rows_selected");
  });
});

/** A consumer can have two copies of `@datatablex/react` installed; `instanceof` returns `false` there, structural guards do not. */
describe("structural error guards", () => {
  class OtherCopyRequestError extends Error {
    name = "DataTableRequestError";
    status = 429;
  }
  class OtherCopyBusyError extends Error {
    name = "ExportBusyError";
  }
  class OtherCopyRowLimitError extends Error {
    name = "ExportRowLimitError";
    maxRows = 10;
    source = "server";
  }

  it("also recognizes an error from another copy", () => {
    expect(new OtherCopyRequestError("x") instanceof DataTableRequestError).toBe(false);
    expect(isDataTableRequestError(new OtherCopyRequestError("x"))).toBe(true);
    expect(isExportBusyError(new OtherCopyBusyError("x"))).toBe(true);
    expect(isExportRowLimitError(new OtherCopyRowLimitError("x"))).toBe(true);
  });

  it("does not recognize unrelated errors or partial shapes", () => {
    expect(isDataTableRequestError(new Error("x"))).toBe(false);
    expect(isDataTableRequestError({ name: "DataTableRequestError", status: 400 })).toBe(false);
    expect(isExportRowLimitError(Object.assign(new Error("x"), { name: "ExportRowLimitError" }))).toBe(false);
    expect(isExportBusyError("ExportBusyError")).toBe(false);
  });
});