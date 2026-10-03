import { describe, expect, it } from "vitest";
import { isDataTableEndpointMeta, isDataTableFieldOptions } from "../guards.js";
import type { DataTableEndpointMeta } from "../types.js";

const meta: DataTableEndpointMeta = {
  version: 1,
  protocol: { version: 1, supported: [1] },
  primaryKey: "id",
  limits: {
    maxPageSize: 500,
    maxFilterDepth: 3,
    maxFilterCount: 50,
    maxInValues: 500,
    maxSearchLength: 200,
    maxSortCount: 3,
    maxOffset: null,
  },
  fields: {
    id: { type: "number", filterOperators: ["eq", "in"], sortable: false, searchable: false },
    name: { type: "text", filterOperators: ["contains"], sortable: true, searchable: true },
  },
};

describe("isDataTableEndpointMeta", () => {
  it("accepts a well-formed meta", () => {
    expect(isDataTableEndpointMeta(meta)).toBe(true);
    expect(isDataTableEndpointMeta({ ...meta, limits: { ...meta.limits, maxOffset: 0 } })).toBe(true);
  });

  it("validates the optional export block", () => {
    expect(isDataTableEndpointMeta({ ...meta, export: { formats: { csv: 100_000 }, fields: ["id"] } })).toBe(true);
    // An array of formats (`formats: ["csv"]`) is not part of the wire contract.
    expect(isDataTableEndpointMeta({ ...meta, export: { formats: ["csv"], fields: [] } })).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, export: { formats: { csv: 0 }, fields: [] } })).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, export: { formats: { csv: 10 } } })).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, export: { fields: ["id"] } })).toBe(false);
  });

  it("validates per-format limits and tolerates unknown formats", () => {
    const base = { fields: ["id"] };
    expect(isDataTableEndpointMeta({ ...meta, export: { ...base, formats: { csv: 10, excel: 5, pdf: 1 } } })).toBe(true);
    // A server without CSV simply omits the key.
    expect(isDataTableEndpointMeta({ ...meta, export: { ...base, formats: { excel: 5 } } })).toBe(true);
    // A format this client does not know must not drop the whole meta.
    expect(isDataTableEndpointMeta({ ...meta, export: { ...base, formats: { csv: 10, parquet: "x" } } })).toBe(true);
    expect(isDataTableEndpointMeta({ ...meta, export: { ...base, formats: { excel: 0 } } })).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, export: { ...base, formats: [] } })).toBe(false);
  });

  it("rejects an unknown version", () => {
    expect(isDataTableEndpointMeta({ ...meta, version: 2 })).toBe(false);
  });

  it("rejects non-positive or non-integer limits", () => {
    expect(isDataTableEndpointMeta({ ...meta, limits: { ...meta.limits, maxInValues: 0 } })).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, limits: { ...meta.limits, maxSearchLength: 1.5 } })).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, limits: { ...meta.limits, maxOffset: -1 } })).toBe(false);
  });

  it("rejects unknown operators and field types", () => {
    expect(
      isDataTableEndpointMeta({ ...meta, fields: { x: { ...meta.fields.name, filterOperators: ["regex"] } } }),
    ).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, fields: { x: { ...meta.fields.name, type: "time" } } })).toBe(false);
  });

  it("rejects malformed shapes", () => {
    expect(isDataTableEndpointMeta(null)).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, fields: [] })).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, primaryKey: 1 })).toBe(false);
  });
});

describe("isDataTableEndpointMeta - protocol", () => {
  it("rejects a missing or malformed protocol field", () => {
    const withoutProtocol: Partial<typeof meta> = { ...meta };
    delete withoutProtocol.protocol;
    expect(isDataTableEndpointMeta(withoutProtocol)).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, protocol: { version: 1, supported: [] } })).toBe(false);
    expect(isDataTableEndpointMeta({ ...meta, protocol: { version: "1", supported: [1] } })).toBe(false);
  });

  it("a list of unsupported versions is valid in shape; the decision is left to the client", () => {
    expect(isDataTableEndpointMeta({ ...meta, protocol: { version: 2, supported: [2] } })).toBe(true);
  });
});

describe("options", () => {
  it("hasOptions is optional; when given it must be a boolean", () => {
    const withFlag = (hasOptions: unknown) => ({ ...meta, fields: { ...meta.fields, status: { type: "enum", filterOperators: ["in"], sortable: false, searchable: false, hasOptions } } });
    expect(isDataTableEndpointMeta(withFlag(true))).toBe(true);
    expect(isDataTableEndpointMeta(withFlag(false))).toBe(true);
    expect(isDataTableEndpointMeta(withFlag("yes"))).toBe(false);
  });

  it("isDataTableFieldOptions validates the version and the item shape", () => {
    expect(isDataTableFieldOptions({ version: 1, options: [] })).toBe(true);
    expect(isDataTableFieldOptions({ version: 1, options: [{ label: "Open", value: "open" }, { label: "One", value: 1 }] })).toBe(true);
    expect(isDataTableFieldOptions({ version: 2, options: [] })).toBe(false);
    expect(isDataTableFieldOptions({ version: 1 })).toBe(false);
    expect(isDataTableFieldOptions([{ label: "Open", value: "open" }])).toBe(false);
    expect(isDataTableFieldOptions({ version: 1, options: [{ label: "Open", value: true }] })).toBe(false);
    expect(isDataTableFieldOptions({ version: 1, options: [{ value: "open" }] })).toBe(false);
    expect(isDataTableFieldOptions({ version: 1, options: [null] })).toBe(false);
  });
});
