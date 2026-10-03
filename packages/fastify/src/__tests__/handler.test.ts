import { describe, expect, it } from "vitest";
import type { DataTableQuery } from "@datatablex/core";
import { handleDataTableQuery } from "../handler.js";
import { FieldNotAllowedError, InvalidScopeError } from "../errors.js";
import type { DataTableEndpointConfig } from "../types.js";
import type { TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

function baseConfig(overrides: Partial<DataTableEndpointConfig<TestDB, "access_logs">> = {}): DataTableEndpointConfig<TestDB, "access_logs"> {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
      accessDate: { column: "access_date", type: "datetime", sortable: true, filterOperators: ["gte", "lte"] },
      stadiumName: { column: "stadium_name", type: "text", sortable: true, filterOperators: ["eq", "contains"], searchable: true },
    },
    getContext: () => ({ userId: "u1", roles: [] }),
    authorize: () => true,
    ...overrides,
  };
}

const defaultQuery: DataTableQuery = {
  pagination: { page: 1, pageSize: 20 },
  sorting: [],
  filters: null,
};

const ctx = { userId: "u1", roles: [] };


describe("handleDataTableQuery — projection", () => {
  it("response rows are aliased with the camelCase keys of fields; primaryKey is always included", () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "1" }] : [{ id: 1, accessDate: "2026-01-01", stadiumName: "Riverside" }]));
    return handleDataTableQuery(db, baseConfig({ select: ["stadiumName"] }), defaultQuery, ctx).then((result) => {
      const dataSql = calls.find((c) => !c.sql.includes("count"))!.sql;
      expect(dataSql).toContain('"id" as "id"');
      expect(dataSql).toContain('"stadium_name" as "stadiumName"');
      expect(dataSql).not.toContain('"access_date" as "accessDate"'); // narrowed by select
      expect(result.data).toEqual([{ id: 1, accessDate: "2026-01-01", stadiumName: "Riverside" }]);
    });
  });

  it("without select, ALL keys of fields are projected", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    await handleDataTableQuery(db, baseConfig(), defaultQuery, ctx);
    const dataSql = calls.find((c) => !c.sql.includes("count"))!.sql;
    expect(dataSql).toContain('"id" as "id"');
    expect(dataSql).toContain('"access_date" as "accessDate"');
    expect(dataSql).toContain('"stadium_name" as "stadiumName"');
  });

  it("without select, sensitive fields are NOT in the default projection", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    const config = baseConfig();
    config.fields = { ...config.fields, nationalId: { column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq"] } };
    await handleDataTableQuery(db, config, defaultQuery, ctx);
    const dataSql = calls.find((c) => !c.sql.includes("count"))!.sql;
    expect(dataSql).not.toContain('"nationalId"');
    expect(dataSql).toContain('"stadium_name" as "stadiumName"');
  });
});

describe("handleDataTableQuery — count and skipCount", () => {
  it("the count query has no ORDER BY, the data query does", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "5" }] : []));
    await handleDataTableQuery(db, baseConfig(), { ...defaultQuery, sorting: [{ field: "accessDate", direction: "desc" }] }, ctx);
    const countCall = calls.find((c) => c.sql.includes("count"))!;
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(countCall.sql.toLowerCase()).not.toContain("order by");
    expect(dataCall.sql.toLowerCase()).toContain("order by");
  });

  it("skipCount: true -> only the data query is sent, total is null", async () => {
    const { db, calls } = fakeExecutableDb(() => [{ id: 1, accessDate: "x", stadiumName: "y" }]);
    const result = await handleDataTableQuery(db, baseConfig(), { ...defaultQuery, skipCount: true }, ctx);
    expect(calls).toHaveLength(1);
    expect(result.pagination.total).toBeNull();
  });

  it("without skipCount two queries are sent, total is converted to a number", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "42" }] : []));
    const result = await handleDataTableQuery(db, baseConfig(), defaultQuery, ctx);
    expect(calls).toHaveLength(2);
    expect(result.pagination.total).toBe(42);
  });
});

describe("handleDataTableQuery — pagination", () => {
  it("pageSize is clamped to maxPageSize and the effective value is written to the response", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    const result = await handleDataTableQuery(db, baseConfig({ maxPageSize: 10 }), { ...defaultQuery, pagination: { page: 1, pageSize: 5000 } }, ctx);
    expect(result.pagination.pageSize).toBe(10);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.parameters).toContain(10); // limit
  });

  it("page < 1 is pinned to 1", async () => {
    const { db } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    const result = await handleDataTableQuery(db, baseConfig(), { ...defaultQuery, pagination: { page: 0, pageSize: 20 } }, ctx);
    expect(result.pagination.page).toBe(1);
  });
});

describe("handleDataTableQuery — sorting", () => {
  it("sorting by a non-whitelisted or sortable:false field -> FieldNotAllowedError, no query is sent", async () => {
    const { db, calls } = fakeExecutableDb(() => []);
    await expect(handleDataTableQuery(db, baseConfig(), { ...defaultQuery, sorting: [{ field: "id", direction: "asc" }] }, ctx)).rejects.toBeInstanceOf(FieldNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it("without stableSort, a primaryKey ASC tiebreaker is added", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    await handleDataTableQuery(db, baseConfig(), defaultQuery, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql.toLowerCase()).toContain('order by "id" asc');
  });

  it("when the user sort already contains the stableSort column, the tiebreaker is NOT added again", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    const config = baseConfig({ fields: { ...baseConfig().fields, id: { column: "id", type: "number", sortable: true, filterOperators: ["eq", "in"] } } });
    await handleDataTableQuery(db, config, { ...defaultQuery, sorting: [{ field: "id", direction: "desc" }] }, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql.toLowerCase()).toContain('order by "id" desc');
    expect(dataCall.sql.toLowerCase()).not.toContain('"id" desc, "id" asc');
  });

  it("when the user sorts by ANOTHER column, the tiebreaker is still added", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    await handleDataTableQuery(db, baseConfig(), { ...defaultQuery, sorting: [{ field: "accessDate", direction: "desc" }] }, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql.toLowerCase()).toContain('order by "access_date" desc, "id" asc');
  });

  it("a custom stableSort is used instead of primaryKey", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    await handleDataTableQuery(db, baseConfig({ stableSort: [{ column: "access_date", direction: "desc" }] }), defaultQuery, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql.toLowerCase()).toContain('order by "access_date" desc');
  });

  /**
   * If a custom `stableSort` does not contain the PK, rows with equal
   * `access_date` would have no deterministic order, which causes duplicate or
   * missing rows across pages in offset pagination. The PK is therefore
   * appended to the end automatically.
   */
  it("when a custom stableSort does NOT contain primaryKey, the PK is appended as a tiebreaker", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    await handleDataTableQuery(db, baseConfig({ stableSort: [{ column: "access_date", direction: "desc" }] }), defaultQuery, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql.toLowerCase()).toContain('order by "access_date" desc, "id" asc');
  });

  it("stableSort: [] falls back to the PK alone instead of producing no ORDER BY", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    await handleDataTableQuery(db, baseConfig({ stableSort: [] }), defaultQuery, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql.toLowerCase()).toContain('order by "id" asc');
  });

  it("when a custom stableSort already contains the PK, it is NOT added again", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    await handleDataTableQuery(db, baseConfig({ stableSort: [{ column: "id", direction: "desc" }] }), defaultQuery, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql.toLowerCase()).toContain('order by "id" desc');
    expect(dataCall.sql.toLowerCase()).not.toContain('"id" desc, "id"');
  });
});

describe("handleDataTableQuery — scope and search", () => {
  const countOrEmpty = (q: { sql: string }) => (q.sql.includes("count") ? [{ total: "0" }] : []);

  it("the scope expression goes into the WHERE of both the data and the COUNT query", async () => {
    const { db, calls } = fakeExecutableDb(countOrEmpty);
    await handleDataTableQuery(db, baseConfig({ scope: (eb) => eb("deleted_at", "is", null) }), defaultQuery, ctx);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.sql).toContain('where "deleted_at" is null');
  });

  it("scope receives ctx and is combined with the filter and the search by AND; the scope comes first", async () => {
    const { db, calls } = fakeExecutableDb(countOrEmpty);
    const config = baseConfig({ scope: (eb, c) => eb.and([eb("deleted_at", "is", null), eb("stadium_name", "!=", c.userId)]) });
    const filters = { operator: "AND" as const, filters: [{ field: "id" as const, operator: "eq" as const, value: 1 }] };
    await handleDataTableQuery(db, config, { ...defaultQuery, filters, search: "river" }, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql).toContain('where (("deleted_at" is null and "stadium_name" != $1) and "id" = $2 and "stadium_name" ilike $3)');
    expect(dataCall.parameters.slice(0, 3)).toEqual([ctx.userId, 1, "%river%"]);
  });

  it("authorization through another table is expressed with an EXISTS subquery; with no JOIN, COUNT does not multiply rows", async () => {
    const { db, calls } = fakeExecutableDb(countOrEmpty);
    const config = baseConfig({
      scope: (eb) => eb.exists(eb.selectFrom("access_logs as other").select("other.id").whereRef("other.id", "=", "access_logs.id")),
    });
    await handleDataTableQuery(db, config, defaultQuery, ctx);
    const countCall = calls.find((c) => c.sql.includes("count"))!;
    expect(countCall.sql).toContain("where exists (select");
    expect(countCall.sql).not.toContain(" join ");
  });

  it("eb.lit(true) expresses an unrestricted role explicitly", async () => {
    const { db, calls } = fakeExecutableDb(countOrEmpty);
    await handleDataTableQuery(db, baseConfig({ scope: (eb) => eb.lit(true) }), defaultQuery, ctx);
    expect(calls.find((c) => !c.sql.includes("count"))!.sql).toContain("where true");
  });

  it.each([
    ["undefined", () => undefined],
    ["null", () => null],
    ["query builder", (eb: Parameters<NonNullable<DataTableEndpointConfig<TestDB, "access_logs">["scope"]>>[0]) => eb.selectFrom("access_logs").select("id")],
  ])("a return value that is not an expression (%s) throws InvalidScopeError without sending any query (fail-closed)", async (_label, scope) => {
    const { db, calls } = fakeExecutableDb(() => []);
    const config = baseConfig({ scope: scope as never });
    await expect(handleDataTableQuery(db, config, defaultQuery, ctx)).rejects.toBeInstanceOf(InvalidScopeError);
    expect(calls).toHaveLength(0);
  });

  it("search scans only the searchable fields, joined by OR", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    await handleDataTableQuery(db, baseConfig(), { ...defaultQuery, search: "river" }, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql).toContain('"stadium_name" ilike $1');
    // Fields that are NOT searchable must NEVER enter the search: there must be a single ilike condition.
    expect(dataCall.sql.match(/ilike/g)).toHaveLength(1);
    expect(dataCall.sql).not.toContain('"id" ilike');
    expect(dataCall.sql).not.toContain('"access_date" ilike');
    expect(dataCall.parameters).toContain("%river%");
  });

  it("filter and search are combined by AND at the same time", async () => {
    const { db, calls } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    const filters = { operator: "AND" as const, filters: [{ field: "id" as const, operator: "eq" as const, value: 1 }] };
    await handleDataTableQuery(db, baseConfig(), { ...defaultQuery, filters, search: "river" }, ctx);
    const dataCall = calls.find((c) => !c.sql.includes("count"))!;
    expect(dataCall.sql).toContain('"id" = $1');
    expect(dataCall.sql).toContain('"stadium_name" ilike $2');
  });
});
