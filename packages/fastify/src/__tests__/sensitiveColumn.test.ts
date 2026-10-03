import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { assertValidEndpointConfig } from "../config.js";
import { datatableRoute } from "../datatableRoute.js";
import { validateDataTableQuery } from "../validate.js";
import type { DataTableEndpointConfig, FieldConfig } from "../types.js";
import type { TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

type Config = DataTableEndpointConfig<TestDB, "access_logs">;
type Field = FieldConfig<TestDB, "access_logs">;

function config(extra: Record<string, Field> = {}, overrides: Partial<Config> = {}): Config {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
      stadiumName: { column: "stadium_name", type: "text", filterOperators: ["eq", "contains"], searchable: true },
      nationalId: { column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq"] },
      ...extra,
    },
    select: ["id", "stadiumName"],
    getContext: () => ({ userId: "u1", roles: ["read"] }),
    authorize: () => true,
    ...overrides,
  };
}

/** The rule is bound to the COLUMN, not the key. */
describe("alias of a sensitive column", () => {
  it("a second key mapping the same column cannot enable contains/searchable/sortable; the message names both keys", () => {
    expect(() => assertValidEndpointConfig(config({ nationalIdRaw: { column: "nationalId", type: "text", filterOperators: ["contains"] } }))).toThrow(
      /field "nationalIdRaw" \(maps the same column as sensitive "nationalId"\) allows only the operators eq, isNull, isNotNull/,
    );
    expect(() => assertValidEndpointConfig(config({ nationalIdRaw: { column: "nationalId", type: "text", searchable: true } }))).toThrow(/nationalIdRaw.*cannot be searchable/);
    expect(() => assertValidEndpointConfig(config({ nationalIdRaw: { column: "nationalId", type: "text", sortable: true } }))).toThrow(/nationalIdRaw.*cannot be sortable/);
    expect(() => assertValidEndpointConfig(config({ nationalIdRaw: { column: "nationalId", type: "text", filterOperators: ["in"] } }))).toThrow(/nationalIdRaw/);
  });

  it("an alias with no operators, not searchable, not sortable and outside the projection is valid", () => {
    expect(() => assertValidEndpointConfig(config({ hidden: { column: "nationalId", type: "text" } }))).not.toThrow();
    expect(() => assertValidEndpointConfig(config({ hidden: { column: "nationalId", type: "text", filterOperators: ["eq"] } }))).not.toThrow();
  });

  it("an alias that enters the projection requires declassify; it passes when given (admin pattern)", () => {
    const projected = { nationalIdMasked: { column: "nationalId", type: "text" } satisfies Field };
    expect(() => assertValidEndpointConfig(config(projected, { select: ["id", "nationalIdMasked"] }))).toThrow(/declassify: true/);
    // Without `select`, the default projection covers every NON-sensitive field — the alias is included.
    expect(() => assertValidEndpointConfig(config(projected, { select: undefined }))).toThrow(/declassify: true/);
    expect(() => assertValidEndpointConfig(config({ nationalIdMasked: { ...projected.nationalIdMasked, declassify: true } }, { select: ["id", "nationalIdMasked"] }))).not.toThrow();
  });

  it("an alias that enters export.fields requires declassify too", () => {
    const alias = { nationalIdMasked: { column: "nationalId", type: "text" } satisfies Field };
    expect(() => assertValidEndpointConfig(config(alias, { select: ["id", "nationalIdMasked"], export: {} }))).toThrow(/declassify: true/);
    expect(() => assertValidEndpointConfig(config(alias, { select: ["id", "stadiumName", "nationalIdMasked"], export: { fields: ["id"] } }))).toThrow(/declassify: true/);
  });

  it("declassify does not lift the restrictions and is a boot error elsewhere", () => {
    expect(() =>
      assertValidEndpointConfig(config({ nationalIdMasked: { column: "nationalId", type: "text", declassify: true, filterOperators: ["contains"] } }, { select: ["id", "nationalIdMasked"] })),
    ).toThrow(/allows only the operators eq, isNull, isNotNull/);
    expect(() => assertValidEndpointConfig(config({ status: { column: "status", type: "text", declassify: true } }))).toThrow(/sets declassify: true but does not map a sensitive column/);
    expect(() => assertValidEndpointConfig(config({}, { fields: { ...config().fields, nationalId: { column: "nationalId", type: "text", sensitive: true, declassify: true, filterOperators: ["eq"] } } }))).toThrow(
      /sets declassify: true/,
    );
  });
});

/** Request rule: at most one sensitive leaf, and it must be a direct child of the root AND. */
describe("sensitive filter request rule", () => {
  const query = (filters: unknown) => ({ pagination: { page: 1, pageSize: 10 }, sorting: [], filters });
  const eqNationalId = (value = "10000000146") => ({ field: "nationalId", operator: "eq", value });
  const cfg = config({ nationalIdMasked: { column: "nationalId", type: "text", declassify: true, filterOperators: ["eq"] } }, { select: ["id", "nationalIdMasked"] });

  it("a single sensitive eq passes in the root AND", () => {
    expect(() => validateDataTableQuery(query({ operator: "AND", filters: [eqNationalId(), { field: "id", operator: "eq", value: 1 }] }), cfg)).not.toThrow();
  });

  it.each([
    ["under an OR root", { operator: "OR", filters: [eqNationalId(), { field: "id", operator: "eq", value: 1 }] }],
    ["in an OR group", { operator: "AND", filters: [{ operator: "OR", filters: [eqNationalId(), { field: "id", operator: "eq", value: 2 }] }] }],
    ["in a nested AND group", { operator: "AND", filters: [{ operator: "AND", filters: [eqNationalId()] }] }],
  ])("%s is rejected", (_name, filters) => {
    expect(() => validateDataTableQuery(query(filters), cfg)).toThrow(/filters a sensitive column/);
  });

  it("two sensitive leaves (alias included) are rejected; guesses cannot be multiplied with OR", () => {
    expect(() => validateDataTableQuery(query({ operator: "AND", filters: [eqNationalId("1"), eqNationalId("2")] }), cfg)).toThrow(/at most one sensitive filter/);
    const alias = { field: "nationalIdMasked", operator: "eq", value: "1" };
    expect(() => validateDataTableQuery(query({ operator: "AND", filters: [eqNationalId("1"), alias] }), cfg)).toThrow(/at most one sensitive filter/);
  });

  it("over HTTP the rule is 400 with the validation code", async () => {
    const app = Fastify();
    app.post("/q", datatableRoute(fakeExecutableDb(() => [{ total: "0" }]).db, cfg));
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/q", payload: query({ operator: "OR", filters: [eqNationalId("1"), eqNationalId("2")] }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation");
  });
});
