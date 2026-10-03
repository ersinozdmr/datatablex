import { describe, expect, it } from "vitest";
import { assertValidEndpointConfig } from "../config.js";
import { describeDataTableEndpoint } from "../describe.js";
import { handleDataTableQuery } from "../handler.js";
import { validateDataTableQuery } from "../validate.js";
import type { DataTableEndpointConfig } from "../types.js";
import type { TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

/**
 * Exported paths that BYPASS `datatableRoute` are subject to the boot-time
 * rules too: an integration that calls `validateDataTableQuery` or
 * `handleDataTableQuery` directly must not lose the sensitive-field allowlist
 * or the limit validation.
 */
function leakyConfig(): DataTableEndpointConfig<TestDB, "access_logs"> {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
      // Substring filter and search on a sensitive field — a predicate oracle.
      nationalId: { column: "nationalId", type: "text", sensitive: true, searchable: true, filterOperators: ["contains"] },
    },
    getContext: () => ({ userId: "u1", roles: [] }),
    authorize: () => true,
  };
}

const query = { pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null };

describe("assertValidEndpointConfig — paths outside datatableRoute", () => {
  it("validateDataTableQuery rejects a broken config", () => {
    expect(() => validateDataTableQuery(query, leakyConfig())).toThrow(/sensitive field "nationalId"/);
  });

  it("handleDataTableQuery rejects a broken config; no query is sent", async () => {
    const { db, calls } = fakeExecutableDb(() => []);
    await expect(handleDataTableQuery(db, leakyConfig(), query, { userId: "u1", roles: [] })).rejects.toThrow(/sensitive field "nationalId"/);
    expect(calls).toHaveLength(0);
  });

  it("describeDataTableEndpoint produces no meta for a broken config", () => {
    expect(() => describeDataTableEndpoint({ ...leakyConfig(), maxPageSize: 0 })).toThrow(/maxPageSize must be a positive/);
  });

  it("a valid config is validated once and accepted", () => {
    const config = leakyConfig();
    config.fields.nationalId = { column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq"] };
    expect(() => assertValidEndpointConfig(config)).not.toThrow();
    expect(() => validateDataTableQuery(query, config)).not.toThrow();
  });

  it("a baseQuery field is not silently ignored — it is rejected at boot with a descriptive error", () => {
    const config = { ...leakyConfig(), fields: { id: { column: "id" as const, type: "number" as const, filterOperators: ["eq" as const, "in" as const] } }, baseQuery: () => null };
    expect(() => assertValidEndpointConfig(config as never)).toThrow(/`baseQuery` is not supported/);
  });

  it("a non-function scope is rejected at boot", () => {
    const config = { ...leakyConfig(), fields: { id: { column: "id" as const, type: "number" as const, filterOperators: ["eq" as const, "in" as const] } }, scope: "deleted_at is null" };
    expect(() => assertValidEndpointConfig(config as never)).toThrow(/scope must be a function/);
  });
});

