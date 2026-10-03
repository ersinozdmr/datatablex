import { describe, expect, it } from "vitest";
import type { Filter, FilterGroup } from "@datatablex/core";
import { escapeLike, filterExpression, leafExpression } from "../filterExpression.js";
import { FieldNotAllowedError, InvalidFilterValueError } from "../errors.js";
import type { FieldConfig } from "../types.js";
import { compileOnlyDb } from "./kyselyTestUtils.js";
import type { TestDB } from "./kyselyTestUtils.js";

const fields: Record<string, FieldConfig<TestDB, "access_logs">> = {
  id: { column: "id", type: "number", filterOperators: ["eq", "in", "notIn"] },
  accessDate: { column: "access_date", type: "datetime", filterOperators: ["gte", "lte", "between", "isNull", "isNotNull"] },
  stadiumName: { column: "stadium_name", type: "text", filterOperators: ["eq", "neq", "contains", "startsWith", "endsWith", "notContains", "notStartsWith", "notEndsWith"], searchable: true },
  nationalId: {
    column: "nationalId",
    type: "text",
    filterOperators: ["eq"],
    parseValue: (raw) => {
      if (typeof raw !== "string" || raw.length !== 11) throw new Error("nationalId must be 11 digits");
      return raw;
    },
  },
};

function compileLeaf(filter: Filter) {
  const db = compileOnlyDb();
  const query = db
    .selectFrom("access_logs")
    .where((eb) => leafExpression(eb, filter, fields))
    .selectAll();
  return query.compile();
}

function compileGroup(group: FilterGroup) {
  const db = compileOnlyDb();
  const query = db
    .selectFrom("access_logs")
    .where((eb) => filterExpression(eb, group, fields))
    .selectAll();
  return query.compile();
}

describe("leafExpression — operator → SQL mapping", () => {
  it.each([
    ["eq", "=", ["Springfield"]],
    ["neq", "!=", ["Springfield"]],
  ] as const)("%s → %s", (operator, sqlOp, [value]) => {
    const { sql, parameters } = compileLeaf({ field: "stadiumName", operator, value: value! } as Filter);
    expect(sql).toContain(`"stadium_name" ${sqlOp} $1`);
    expect(parameters).toEqual([value]);
  });

  it("gte/lte → >= / <=", () => {
    expect(compileLeaf({ field: "accessDate", operator: "gte", value: "2026-01-01" }).sql).toContain('"access_date" >= $1');
    expect(compileLeaf({ field: "accessDate", operator: "lte", value: "2026-01-01" }).sql).toContain('"access_date" <= $1');
  });

  it("contains → %term%", () => {
    const { sql, parameters } = compileLeaf({ field: "stadiumName", operator: "contains", value: "spring" });
    expect(sql).toContain('"stadium_name" ilike $1');
    expect(parameters).toEqual(["%spring%"]);
  });

  it("startsWith → term%, endsWith → %term", () => {
    expect(compileLeaf({ field: "stadiumName", operator: "startsWith", value: "spring" }).parameters).toEqual(["spring%"]);
    expect(compileLeaf({ field: "stadiumName", operator: "endsWith", value: "spring" }).parameters).toEqual(["%spring"]);
  });

  it.each([
    ["notContains", "%spring%"],
    ["notStartsWith", "spring%"],
    ["notEndsWith", "%spring"],
  ] as const)("%s → NOT ILIKE %s", (operator, pattern) => {
    const { sql, parameters } = compileLeaf({ field: "stadiumName", operator, value: "spring" });
    expect(sql).toContain('"stadium_name" not ilike $1');
    expect(parameters).toEqual([pattern]);
  });

  it("wildcard characters are escaped in negative operators", () => {
    expect(compileLeaf({ field: "stadiumName", operator: "notContains", value: "50%_\\" }).parameters).toEqual(["%50\\%\\_\\\\%"]);
  });

  it("between → BETWEEN $1 AND $2", () => {
    const { sql, parameters } = compileLeaf({ field: "accessDate", operator: "between", value: ["2026-01-01", "2026-02-01"] });
    expect(sql.toLowerCase()).toContain("between $1 and $2");
    expect(parameters).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("in/notIn → parameterized list", () => {
    const inQ = compileLeaf({ field: "id", operator: "in", value: [1, 2, 3] });
    expect(inQ.sql).toContain('"id" in ($1, $2, $3)');
    expect(inQ.parameters).toEqual([1, 2, 3]);

    const notInQ = compileLeaf({ field: "id", operator: "notIn", value: [1, 2] });
    expect(notInQ.sql).toContain('"id" not in ($1, $2)');
  });

  it("empty in array → always false, empty notIn → always true (0 parameters)", () => {
    const emptyIn = compileLeaf({ field: "id", operator: "in", value: [] });
    expect(emptyIn.parameters).toEqual([]);
    expect(emptyIn.sql.toLowerCase()).toContain("false");

    const emptyNotIn = compileLeaf({ field: "id", operator: "notIn", value: [] });
    expect(emptyNotIn.parameters).toEqual([]);
    expect(emptyNotIn.sql.toLowerCase()).toContain("true");
  });

  it("isNull/isNotNull → IS (NOT) NULL without parameters", () => {
    const isNull = compileLeaf({ field: "accessDate", operator: "isNull" });
    expect(isNull.sql).toContain('"access_date" is null');
    expect(isNull.parameters).toEqual([]);

    const isNotNull = compileLeaf({ field: "accessDate", operator: "isNotNull" });
    expect(isNotNull.sql).toContain('"access_date" is not null');
  });
});

describe("leafExpression — whitelist rejection", () => {
  it("field not defined in fields → FieldNotAllowedError", () => {
    expect(() => compileLeaf({ field: "ghost", operator: "eq", value: "x" })).toThrow(FieldNotAllowedError);
  });

  it("field defined but operator not in filterOperators → FieldNotAllowedError", () => {
    // accessDate carries only gte/lte/between/isNull — eq is NOT allowed.
    expect(() => compileLeaf({ field: "accessDate", operator: "eq", value: "2026-01-01" })).toThrow(FieldNotAllowedError);
  });

  it("nullary operators are rejected too unless explicitly added to filterOperators", () => {
    // isNull is not in the filterOperators list of stadiumName.
    expect(() => compileLeaf({ field: "stadiumName", operator: "isNull" })).toThrow(FieldNotAllowedError);
  });
});

describe("leafExpression — parseValue contract", () => {
  it("an error thrown by parseValue is converted to InvalidFilterValueError (cause is preserved)", () => {
    try {
      compileLeaf({ field: "nationalId", operator: "eq", value: "short" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidFilterValueError);
      expect((err as InvalidFilterValueError).cause).toBeInstanceOf(Error);
    }
  });

  it("parseValue writes the transformed value to the query for valid input", () => {
    const { parameters } = compileLeaf({ field: "nationalId", operator: "eq", value: "12345678901" });
    expect(parameters).toEqual(["12345678901"]);
  });
});

describe("escapeLike", () => {
  it("%, _ and \\ are escaped", () => {
    expect(escapeLike("50%_off\\now")).toBe("50\\%\\_off\\\\now");
  });

  it("null/undefined → empty string", () => {
    expect(escapeLike(null)).toBe("");
    expect(escapeLike(undefined)).toBe("");
  });
});

describe("filterExpression — group recursion", () => {
  it("an AND group combines all leaves", () => {
    const group: FilterGroup = {
      operator: "AND",
      filters: [
        { field: "stadiumName", operator: "eq", value: "Springfield" },
        { field: "id", operator: "in", value: [1, 2] },
      ],
    };
    const { sql, parameters } = compileGroup(group);
    expect(sql).toContain('"stadium_name" = $1');
    expect(sql).toContain('"id" in ($2, $3)');
    expect(parameters).toEqual(["Springfield", 1, 2]);
  });

  it("a nested OR group is parenthesized", () => {
    const group: FilterGroup = {
      operator: "AND",
      filters: [
        { field: "id", operator: "eq", value: 1 },
        {
          operator: "OR",
          filters: [
            { field: "stadiumName", operator: "eq", value: "A" },
            { field: "stadiumName", operator: "eq", value: "B" },
          ],
        },
      ],
    };
    const { sql } = compileGroup(group);
    expect(sql).toMatch(/\("stadium_name" = \$2 or "stadium_name" = \$3\)/);
  });

  it("EMPTY group — the neutral element is TRUE for AND and FALSE for OR (SQL-level defense independent of Zod)", () => {
    const andEmpty = compileGroup({ operator: "AND", filters: [] });
    expect(andEmpty.sql.toLowerCase()).toContain("true");

    const orEmpty = compileGroup({ operator: "OR", filters: [] });
    expect(orEmpty.sql.toLowerCase()).toContain("false");
  });
});
