import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { datatableRoute } from "../datatableRoute.js";
import type { DataTableEndpointConfig } from "../types.js";
import type { TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

function baseConfig(overrides: Partial<DataTableEndpointConfig<TestDB, "access_logs">> = {}): DataTableEndpointConfig<TestDB, "access_logs"> {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
      stadiumName: { column: "stadium_name", type: "text", sortable: true, filterOperators: ["eq", "contains"], searchable: true },
    },
    getContext: () => ({ userId: "u1", roles: ["access_logs:read"] }),
    authorize: (ctx) => ctx.roles.includes("access_logs:read"),
    ...overrides,
  };
}

describe("datatableRoute — boot-time validation", () => {
  const { db } = fakeExecutableDb(() => []);

  it("throws when primaryKey is not defined in fields", () => {
    expect(() => datatableRoute(db, baseConfig({ primaryKey: "ghost" }))).toThrow(/primaryKey/);
  });

  it("throws when the filterOperators of primaryKey do not include 'in'", () => {
    const config = baseConfig({ fields: { id: { column: "id", type: "number", filterOperators: ["eq"] } } });
    expect(() => datatableRoute(db, config)).toThrow(/filterOperators must include "in"/);
  });

  it("throws when select points to an unknown fields key", () => {
    expect(() => datatableRoute(db, baseConfig({ select: ["ghost"] }))).toThrow(/select key/);
  });

  it("throws when a searchable: true field is not type: \"text\"", () => {
    const config = baseConfig({
      fields: {
        id: { column: "id", type: "number", filterOperators: ["eq", "in"], searchable: true },
      },
    });
    expect(() => datatableRoute(db, config)).toThrow(/must have type: "text"/);
  });

  /**
   * The filter-side counterpart of the `searchable` -> `type: "text"` guard.
   * A `type: "number"` field that carries `filterOperators: ["contains"]` must
   * not pass boot silently: it would compile `"id" ilike $1` on the first
   * request and produce a 500 in PostgreSQL.
   */
  it.each(["contains", "startsWith", "endsWith", "notContains", "notStartsWith", "notEndsWith"])(
    "throws when a field with %s in filterOperators is not type: \"text\"",
    (operator) => {
      const config = baseConfig({
        fields: {
          id: { column: "id", type: "number", filterOperators: ["eq", "in", operator as "contains"] },
          stadiumName: { column: "stadium_name", type: "text", filterOperators: ["eq"], searchable: true },
        },
      });
      expect(() => datatableRoute(db, config)).toThrow(/include a text operator/);
    },
  );

  it("a text operator is allowed on a type: \"text\" field", () => {
    // The stadiumName field of baseConfig is already type: "text" and carries contains.
    expect(() => datatableRoute(db, baseConfig())).not.toThrow();
  });

  it("does not throw on a valid config", () => {
    expect(() => datatableRoute(db, baseConfig())).not.toThrow();
  });

  const positiveLimits = ["maxPageSize", "maxFilterDepth", "maxFilterCount", "maxInValues", "maxSearchLength", "maxSortCount"] as const;
  describe.each(positiveLimits)("%s", (key) => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])("an invalid value (%s) stops boot", (value) => {
      expect(() => datatableRoute(db, baseConfig({ [key]: value }))).toThrow(new RegExp(`${key} must be a positive`));
    });

    it("1 is accepted", () => {
      expect(() => datatableRoute(db, baseConfig({ [key]: 1 }))).not.toThrow();
    });
  });

  it("maxOffset: 0 is accepted", () => {
    expect(() => datatableRoute(db, baseConfig({ maxOffset: 0 }))).not.toThrow();
  });
});

/**
 * Allowlist for sensitive fields (see `FieldConfig.sensitive`): even when the
 * field is not in the projection, a substring or range filter, a search or a
 * sort leaks its value.
 */
describe("datatableRoute — sensitive field (predicate oracle) rules", () => {
  const { db } = fakeExecutableDb(() => []);
  const withNationalId = (nationalId: DataTableEndpointConfig<TestDB, "access_logs">["fields"][string]) =>
    baseConfig({ fields: { ...baseConfig().fields, nationalId } });

  it.each(["contains", "startsWith", "endsWith", "notContains", "notStartsWith", "notEndsWith", "gt", "gte", "lt", "lte", "between", "neq", "in", "notIn"] as const)(
    "the %s operator on a sensitive field stops boot",
    (operator) => {
      expect(() => datatableRoute(db, withNationalId({ column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq", operator] }))).toThrow(
        /sensitive field "nationalId" allows only the operators/,
      );
    },
  );

  it("a sensitive field cannot be searchable", () => {
    expect(() => datatableRoute(db, withNationalId({ column: "nationalId", type: "text", sensitive: true, searchable: true, filterOperators: ["eq"] }))).toThrow(
      /cannot be searchable/,
    );
  });

  it("a sensitive field cannot be sortable", () => {
    expect(() => datatableRoute(db, withNationalId({ column: "nationalId", type: "text", sensitive: true, sortable: true, filterOperators: ["eq"] }))).toThrow(
      /cannot be sortable/,
    );
  });

  it("a sensitive field cannot be in an explicit select", () => {
    const config = { ...withNationalId({ column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq"] }), select: ["stadiumName", "nationalId"] };
    expect(() => datatableRoute(db, config)).toThrow(/sensitive fields cannot be projected/);
  });

  it("primaryKey cannot be sensitive", () => {
    const config = baseConfig({ fields: { id: { column: "id", type: "number", sensitive: true, filterOperators: ["eq", "in"] } } });
    expect(() => datatableRoute(db, config)).toThrow(/primaryKey "id" cannot be sensitive/);
  });

  it("a sensitive field with eq/isNull/isNotNull is valid", () => {
    expect(() => datatableRoute(db, withNationalId({ column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq", "isNull", "isNotNull"] }))).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN])("an invalid maxOffset (%s) stops boot", (maxOffset) => {
    expect(() => datatableRoute(db, baseConfig({ maxOffset }))).toThrow(/maxOffset/);
  });

  it("the column of a sensitive field cannot be in stableSort", () => {
    const config = { ...withNationalId({ column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq"] }), stableSort: [{ column: "nationalId" as const, direction: "asc" as const }] };
    expect(() => datatableRoute(db, config)).toThrow(/stableSort column "nationalId" belongs to sensitive field "nationalId"/);
  });

  it("a column repeated in stableSort stops boot", () => {
    const stableSort = [
      { column: "stadium_name" as const, direction: "asc" as const },
      { column: "stadium_name" as const, direction: "desc" as const },
    ];
    expect(() => datatableRoute(db, baseConfig({ stableSort }))).toThrow(/more than once/);
  });

  it("boot stops when the primaryKey column is not last in stableSort; it is valid when last", () => {
    const early = [
      { column: "id" as const, direction: "asc" as const },
      { column: "stadium_name" as const, direction: "asc" as const },
    ];
    expect(() => datatableRoute(db, baseConfig({ stableSort: early }))).toThrow(/must be last/);
    expect(() => datatableRoute(db, baseConfig({ stableSort: [...early].reverse() }))).not.toThrow();
  });

  it("stableSort with a non-sensitive column is valid", () => {
    const config = { ...withNationalId({ column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq"] }), stableSort: [{ column: "stadium_name" as const, direction: "desc" as const }] };
    expect(() => datatableRoute(db, config)).not.toThrow();
  });
});

describe("datatableRoute — runtime behavior", () => {
  function buildApp(config: DataTableEndpointConfig<TestDB, "access_logs">) {
    const { db } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "1" }] : [{ id: 1, stadiumName: "Riverside" }]));
    const app = Fastify();
    app.post("/query", datatableRoute(db, config));
    return app;
  }

  it("authorize false -> 403, handleDataTableQuery is never called", async () => {
    const app = buildApp(baseConfig({ authorize: () => false }));
    const res = await app.inject({ method: "POST", url: "/query", payload: { pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null } });
    expect(res.statusCode).toBe(403);
  });

  it("returns 400 + Validation Error when the body shape is invalid (Zod)", async () => {
    const app = buildApp(baseConfig());
    const res = await app.inject({ method: "POST", url: "/query", payload: { pagination: { page: "one", pageSize: 20 }, sorting: [], filters: null } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation Error");
  });

  it("a sort field outside the whitelist (FieldNotAllowedError) -> 400", async () => {
    const app = buildApp(baseConfig());
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: { pagination: { page: 1, pageSize: 20 }, sorting: [{ field: "ghost", direction: "asc" }], filters: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it("sending search to an endpoint with no searchable field (SearchNotSupportedError) -> 400", async () => {
    const app = buildApp(
      baseConfig({ fields: { id: { column: "id", type: "number", filterOperators: ["eq", "in"] } } }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: { pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null, search: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a valid request -> 200, returns data/pagination", async () => {
    const app = buildApp(baseConfig());
    const res = await app.inject({ method: "POST", url: "/query", payload: { pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([{ id: 1, stadiumName: "Riverside" }]);
    expect(body.pagination).toEqual({ page: 1, pageSize: 20, total: 1 });
  });

  it("EVERY error body carries message, so a client can read a single field", async () => {
    // 403
    const forbidden = await buildApp(baseConfig({ authorize: () => false })).inject({
      method: "POST",
      url: "/query",
      payload: { pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null },
    });
    expect(forbidden.json()).toMatchObject({ error: "Forbidden", message: "Forbidden" });

    // ZodError: message makes the first issue readable, details is kept
    const invalid = await buildApp(baseConfig()).inject({
      method: "POST",
      url: "/query",
      payload: { pagination: { page: "one", pageSize: 20 }, sorting: [], filters: null },
    });
    const invalidBody = invalid.json();
    expect(invalidBody.error).toBe("Validation Error");
    expect(invalidBody.message).toContain("pagination.page");
    expect(Array.isArray(invalidBody.details)).toBe(true);

    // An error class that carries statusCode: the actual text is in `message` of the Fastify body
    const notAllowed = await buildApp(baseConfig()).inject({
      method: "POST",
      url: "/query",
      payload: { pagination: { page: 1, pageSize: 20 }, sorting: [{ field: "ghost", direction: "asc" }], filters: null },
    });
    expect(notAllowed.json().message).toBe("Field or operator not allowed: ghost");
  });

  /**
   * End to end through `app.inject()`: the real Fastify JSON body parse plus
   * the `validateDataTableQuery` chain must return 400, not 500 (RangeError),
   * for an adversarial deeply nested `filters` body.
   */
  it("a very deep filters body returns 400 through app.inject(), NOT 500 (RangeError)", async () => {
    const app = buildApp(baseConfig());
    // The raw JSON TEXT is built iteratively: building a JS object and passing
    // it to `JSON.stringify` (recursive) would overflow the test process
    // itself; a real attacker sends the body as a ready-made byte string for
    // the same reason and never calls `JSON.stringify` on the JS side.
    let filtersJson = '{"field":"id","operator":"eq","value":1}';
    for (let i = 0; i < 5000; i++) {
      filtersJson = `{"operator":"AND","filters":[${filtersJson}]}`;
    }
    const res = await app.inject({
      method: "POST",
      url: "/query",
      headers: { "content-type": "application/json" },
      payload: `{"pagination":{"page":1,"pageSize":20},"sorting":[],"filters":${filtersJson}}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation Error");
  });

  it("when preHandler rejects, getContext/authorize are NEVER reached (fail-closed chain)", async () => {
    const getContext = vi.fn(() => ({ userId: "u1", roles: ["access_logs:read"] }));
    const authorize = vi.fn(() => true);
    const { db } = fakeExecutableDb(() => []);
    const app = Fastify();
    app.post(
      "/query",
      {
        preHandler: async (_req, reply) => {
          return reply.code(401).send({ error: "Unauthorized" }); // Assumes JWT verification failed here
        },
      },
      datatableRoute(db, baseConfig({ getContext, authorize })),
    );

    const res = await app.inject({ method: "POST", url: "/query", payload: { pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null } });
    expect(res.statusCode).toBe(401);
    expect(getContext).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe("datatableRoute — meta handler", () => {
  function buildApp(config: DataTableEndpointConfig<TestDB, "access_logs">) {
    const { db } = fakeExecutableDb(() => []);
    const app = Fastify();
    const route = datatableRoute(db, config);
    app.post("/query", route);
    app.get("/query/meta", route.meta);
    return app;
  }

  it("returns the effective limits and the field whitelist, EXCLUDING the DB column and the sensitive flag", async () => {
    const app = buildApp(
      baseConfig({
        maxInValues: 100,
        maxOffset: 10_000,
        fields: {
          id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
          stadiumName: { column: "stadium_name", type: "text", sortable: true, filterOperators: ["eq", "contains"], searchable: true },
          nationalId: { column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq"] },
        },
      }),
    );
    const res = await app.inject({ method: "GET", url: "/query/meta" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: 1,
      protocol: { version: 1, supported: [1] },
      primaryKey: "id",
      limits: {
        maxPageSize: 500,
        maxFilterDepth: 3,
        maxFilterCount: 50,
        maxInValues: 100,
        maxSearchLength: 200,
        maxSortCount: 3,
        maxOffset: 10_000,
      },
      fields: {
        id: { type: "number", filterOperators: ["eq", "in"], sortable: false, searchable: false },
        stadiumName: { type: "text", filterOperators: ["eq", "contains"], sortable: true, searchable: true },
        nationalId: { type: "text", filterOperators: ["eq"], sortable: false, searchable: false },
      },
    });
    expect(res.body).not.toContain("stadium_name");
    expect(res.body).not.toContain("sensitive");
  });

  it("returns null when maxOffset is not given", async () => {
    const res = await buildApp(baseConfig()).inject({ method: "GET", url: "/query/meta" });
    expect(res.json().limits.maxOffset).toBeNull();
  });

  it("authorize false -> 403", async () => {
    const res = await buildApp(baseConfig({ authorize: () => false })).inject({ method: "GET", url: "/query/meta" });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Forbidden");
  });
});

describe("datatableRoute — protocol version", () => {
  function buildApp() {
    const { db } = fakeExecutableDb((q) => (q.sql.includes("count") ? [{ total: "0" }] : []));
    const app = Fastify();
    const route = datatableRoute(db, baseConfig());
    app.post("/query", route);
    app.get("/query/meta", route.meta);
    return app;
  }
  const payload = { pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null };

  it.each([
    ["no header (treated as version 1)", {}],
    ["version 1", { "x-datatablex-protocol": "1" }],
  ])("%s -> 200", async (_label, headers) => {
    const res = await buildApp().inject({ method: "POST", url: "/query", payload, headers });
    expect(res.statusCode).toBe(200);
  });

  it.each(["2", "abc", ""])("an unsupported version (%j) -> 400, supported versions in the response; getContext is not called", async (value) => {
    const getContext = vi.fn(() => ({ userId: "u1", roles: ["access_logs:read"] }));
    const { db } = fakeExecutableDb(() => []);
    const app = Fastify();
    app.post("/query", datatableRoute(db, baseConfig({ getContext })));
    const res = await app.inject({ method: "POST", url: "/query", payload, headers: { "x-datatablex-protocol": value } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Unsupported Protocol", supported: [1] });
    expect(res.json().message).toContain("protocol");
    expect(getContext).not.toHaveBeenCalled();
  });

  it("the meta route goes through the same check and reports the supported versions", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "GET", url: "/query/meta", headers: { "x-datatablex-protocol": "2" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "GET", url: "/query/meta" });
    expect(ok.json().protocol).toEqual({ version: 1, supported: [1] });
  });
});
