import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { DataTableQuery } from "@datatablex/core";
import { validateDataTableQuery } from "../validate.js";
import { SearchNotSupportedError } from "../errors.js";
import type { DataTableEndpointConfig } from "../types.js";
import type { TestDB } from "./kyselyTestUtils.js";

function baseConfig(overrides: Partial<DataTableEndpointConfig<TestDB, "access_logs">> = {}): DataTableEndpointConfig<TestDB, "access_logs"> {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in", "between", "gte"] },
      stadiumName: { column: "stadium_name", type: "text", filterOperators: ["eq", "contains"], searchable: true },
      accessDate: { column: "access_date", type: "datetime", filterOperators: ["gte", "lte", "between"] },
      visitDay: { column: "access_date", type: "date", filterOperators: ["gte", "lte", "between"] },
      active: { column: "active", type: "boolean", filterOperators: ["eq", "in"] },
      status: { column: "status", type: "enum", filterOperators: ["eq", "in"] },
    },
    getContext: () => ({ userId: "u1", roles: [] }),
    authorize: () => true,
    ...overrides,
  };
}

const minimalQuery: DataTableQuery = {
  pagination: { page: 1, pageSize: 20 },
  sorting: [],
  filters: null,
};

describe("validateDataTableQuery — basic shape", () => {
  it("accepts a valid minimal query", () => {
    expect(validateDataTableQuery(minimalQuery, baseConfig())).toEqual(minimalQuery);
  });

  it("throws ZodError when pagination is missing", () => {
    expect(() => validateDataTableQuery({ sorting: [], filters: null }, baseConfig())).toThrow(z.ZodError);
  });

  it("throws ZodError when page/pageSize is 0 or negative", () => {
    expect(() => validateDataTableQuery({ ...minimalQuery, pagination: { page: 0, pageSize: 20 } }, baseConfig())).toThrow(z.ZodError);
  });

  it("throws ZodError when a sorting item has a direction other than 'asc'/'desc'", () => {
    expect(() => validateDataTableQuery({ ...minimalQuery, sorting: [{ field: "id", direction: "up" }] }, baseConfig())).toThrow(z.ZodError);
  });
});

describe("validateDataTableQuery — text operators require a string", () => {
  function withValue(operator: string, value: unknown) {
    return { ...minimalQuery, filters: { operator: "AND", filters: [{ field: "stadiumName", operator, value }] } };
  }

  it.each(["contains", "startsWith", "endsWith", "notContains", "notStartsWith", "notEndsWith"])("%s: number is rejected", (operator) => {
    expect(() => validateDataTableQuery(withValue(operator, 123), baseConfig())).toThrow(z.ZodError);
  });

  it.each(["contains", "startsWith", "endsWith", "notContains", "notStartsWith", "notEndsWith"])("%s: boolean is rejected", (operator) => {
    expect(() => validateDataTableQuery(withValue(operator, true), baseConfig())).toThrow(z.ZodError);
  });

  it("contains: string is accepted", () => {
    expect(() => validateDataTableQuery(withValue("contains", "Springfield"), baseConfig())).not.toThrow();
  });

  it("notContains: string is accepted", () => {
    expect(() => validateDataTableQuery(withValue("notContains", "Springfield"), baseConfig())).not.toThrow();
  });

  /**
   * The SHAPE layer (operator → value form) accepts number/boolean for `eq`;
   * the layer that rejects them is the TYPE layer (field → value type), which
   * only looks at field/operator pairs that passed the whitelist — that is why
   * fields matching the value type are used here instead of `stadiumName`
   * (see the "field-type × value" block below).
   */
  it("comparison operators accept number/boolean in the shape layer", () => {
    expect(() => validateDataTableQuery(withValue("eq", "Springfield"), baseConfig())).not.toThrow();
    const numberEq = { ...minimalQuery, filters: { operator: "AND", filters: [{ field: "id", operator: "eq", value: 123 }] } };
    const booleanEq = { ...minimalQuery, filters: { operator: "AND", filters: [{ field: "active", operator: "eq", value: true }] } };
    expect(() => validateDataTableQuery(numberEq, baseConfig())).not.toThrow();
    expect(() => validateDataTableQuery(booleanEq, baseConfig())).not.toThrow();
  });
});

/**
 * Runtime validation of the `field.type` + `operator` + `value` triple. The
 * `Filter` type narrows `value` by operator only; matching the field's own
 * type can only be enforced here.
 */
describe("validateDataTableQuery — field-type × value validation", () => {
  function withLeaf(leaf: unknown) {
    return { ...minimalQuery, filters: { operator: "AND", filters: [leaf] } };
  }

  it("type: number field rejects a string value and accepts a number", () => {
    expect(() => validateDataTableQuery(withLeaf({ field: "id", operator: "eq", value: "12" }), baseConfig())).toThrow(z.ZodError);
    expect(() => validateDataTableQuery(withLeaf({ field: "id", operator: "eq", value: 12 }), baseConfig())).not.toThrow();
  });

  it("type: text field rejects a number/boolean value", () => {
    expect(() => validateDataTableQuery(withLeaf({ field: "stadiumName", operator: "eq", value: 123 }), baseConfig())).toThrow(z.ZodError);
    expect(() => validateDataTableQuery(withLeaf({ field: "stadiumName", operator: "eq", value: true }), baseConfig())).toThrow(z.ZodError);
  });

  it("type: boolean field rejects the string 'true'", () => {
    expect(() => validateDataTableQuery(withLeaf({ field: "active", operator: "eq", value: "true" }), baseConfig())).toThrow(z.ZodError);
    expect(() => validateDataTableQuery(withLeaf({ field: "active", operator: "eq", value: false }), baseConfig())).not.toThrow();
  });

  it("type: enum field accepts string and number, rejects boolean", () => {
    expect(() => validateDataTableQuery(withLeaf({ field: "status", operator: "eq", value: "open" }), baseConfig())).not.toThrow();
    expect(() => validateDataTableQuery(withLeaf({ field: "status", operator: "eq", value: 3 }), baseConfig())).not.toThrow();
    expect(() => validateDataTableQuery(withLeaf({ field: "status", operator: "eq", value: true }), baseConfig())).toThrow(z.ZodError);
  });

  it("type: datetime field accepts only ISO 8601 strings that carry TIME + TIMEZONE", () => {
    expect(() => validateDataTableQuery(withLeaf({ field: "accessDate", operator: "gte", value: "2026-09-03T14:00:00Z" }), baseConfig())).not.toThrow();
    expect(() => validateDataTableQuery(withLeaf({ field: "accessDate", operator: "gte", value: "2026-09-03T14:00:00+03:00" }), baseConfig())).not.toThrow();
    // Local time without a timezone — it would make the UTC wire contract environment-dependent, so it is rejected.
    expect(() => validateDataTableQuery(withLeaf({ field: "accessDate", operator: "gte", value: "2026-09-03T14:00:00" }), baseConfig())).toThrow(z.ZodError);
    // Day only — does not satisfy the instant semantics of `datetime`, so it is rejected.
    expect(() => validateDataTableQuery(withLeaf({ field: "accessDate", operator: "gte", value: "2026-09-03" }), baseConfig())).toThrow(z.ZodError);
    // Epoch and locale-dependent formats are explicitly rejected.
    expect(() => validateDataTableQuery(withLeaf({ field: "accessDate", operator: "gte", value: 1788451200000 }), baseConfig())).toThrow(z.ZodError);
    expect(() => validateDataTableQuery(withLeaf({ field: "accessDate", operator: "gte", value: "03.09.2026" }), baseConfig())).toThrow(z.ZodError);
    // Matches the shape but is not a real date (Date.parse → NaN).
    expect(() => validateDataTableQuery(withLeaf({ field: "accessDate", operator: "gte", value: "2026-02-31T00:00:00Z" }), baseConfig())).toThrow(z.ZodError);
  });

  it("type: date field accepts ONLY ISO 8601 calendar-day strings (no time/timezone)", () => {
    expect(() => validateDataTableQuery(withLeaf({ field: "visitDay", operator: "gte", value: "2026-09-03" }), baseConfig())).not.toThrow();
    // Time component — a date column has no instant semantics, so it is rejected.
    expect(() => validateDataTableQuery(withLeaf({ field: "visitDay", operator: "gte", value: "2026-09-03T14:00:00Z" }), baseConfig())).toThrow(z.ZodError);
    expect(() => validateDataTableQuery(withLeaf({ field: "visitDay", operator: "gte", value: "2026-09-03T00:00:00" }), baseConfig())).toThrow(z.ZodError);
    // Matches the shape but is not a real date.
    expect(() => validateDataTableQuery(withLeaf({ field: "visitDay", operator: "gte", value: "2026-02-31" }), baseConfig())).toThrow(z.ZodError);
  });

  it("EVERY element of between/in arrays is validated", () => {
    expect(() => validateDataTableQuery(withLeaf({ field: "id", operator: "between", value: [1, "2"] }), baseConfig())).toThrow(z.ZodError);
    expect(() => validateDataTableQuery(withLeaf({ field: "id", operator: "between", value: [1, 2] }), baseConfig())).not.toThrow();
    expect(() => validateDataTableQuery(withLeaf({ field: "id", operator: "in", value: [1, 2, "3"] }), baseConfig())).toThrow(z.ZodError);
    expect(() =>
      validateDataTableQuery(withLeaf({ field: "accessDate", operator: "between", value: ["2026-09-03T00:00:00Z", "tomorrow"] }), baseConfig()),
    ).toThrow(z.ZodError);
  });

  it("the index of the invalid element is written to the issue path", () => {
    try {
      validateDataTableQuery(withLeaf({ field: "id", operator: "in", value: [1, "2"] }), baseConfig());
      expect.unreachable("expected a ZodError");
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect((err as z.ZodError).issues[0]?.path).toEqual(["filters", "id", 1]);
    }
  });

  it("isNull/isNotNull carry no value, so they are exempt from the type check", () => {
    const config = baseConfig({
      fields: {
        id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
        accessDate: { column: "access_date", type: "datetime", filterOperators: ["isNull"] },
      },
    });
    expect(() => validateDataTableQuery(withLeaf({ field: "accessDate", operator: "isNull" }), config)).not.toThrow();
  });

  /**
   * The whitelist is the primary gate: an undefined field, or an operator that
   * is not enabled on the field, is SILENTLY skipped in this layer and left to
   * the `FieldNotAllowedError` (400) path of `leafExpression`. Otherwise the
   * same whitelist violation would return "Validation Error" or "Field not
   * allowed" depending on the type of the value.
   */
  it("a field/operator outside the whitelist never enters the type check", () => {
    expect(() => validateDataTableQuery(withLeaf({ field: "unknown", operator: "eq", value: true }), baseConfig())).not.toThrow();
    expect(() => validateDataTableQuery(withLeaf({ field: "id", operator: "lte", value: "12" }), baseConfig())).not.toThrow();
  });

  it("leaves in nested groups are validated too", () => {
    const filters = {
      operator: "AND",
      filters: [
        { field: "id", operator: "eq", value: 1 },
        { operator: "OR", filters: [{ field: "id", operator: "eq", value: "2" }] },
      ],
    };
    expect(() => validateDataTableQuery({ ...minimalQuery, filters }, baseConfig())).toThrow(z.ZodError);
  });
});

describe("validateDataTableQuery — empty FilterGroup rejection", () => {
  it("an empty filters array at the root level throws ZodError", () => {
    expect(() => validateDataTableQuery({ ...minimalQuery, filters: { operator: "AND", filters: [] } }, baseConfig())).toThrow(z.ZodError);
  });

  it("a nested empty group (inside a non-empty parent group) also throws ZodError", () => {
    const filters = {
      operator: "AND",
      filters: [{ field: "id", operator: "eq", value: 1 }, { operator: "OR", filters: [] }],
    };
    expect(() => validateDataTableQuery({ ...minimalQuery, filters }, baseConfig())).toThrow(z.ZodError);
  });
});

describe("validateDataTableQuery — request limits", () => {
  it("the same field given twice in sorting throws ZodError", () => {
    const sorting = [
      { field: "stadiumName", direction: "asc" },
      { field: "stadiumName", direction: "desc" },
    ];
    expect(() => validateDataTableQuery({ ...minimalQuery, sorting }, baseConfig())).toThrow(/is given more than once/);
  });

  it("sorting.length > maxSortCount → ZodError", () => {
    const sorting = [
      { field: "id", direction: "asc" },
      { field: "stadiumName", direction: "desc" },
      { field: "accessDate", direction: "asc" },
      { field: "status", direction: "desc" },
    ];
    expect(() => validateDataTableQuery({ ...minimalQuery, sorting }, baseConfig({ maxSortCount: 3 }))).toThrow(/sorting can contain at most 3 items/);
    // A length exactly at the ceiling is accepted.
    expect(() => validateDataTableQuery({ ...minimalQuery, sorting: sorting.slice(0, 3) }, baseConfig({ maxSortCount: 3 }))).not.toThrow();
  });

  it("throws ZodError when the filter depth exceeds maxFilterDepth", () => {
    const deep = {
      operator: "AND" as const,
      filters: [{ operator: "AND" as const, filters: [{ operator: "AND" as const, filters: [{ field: "id", operator: "eq" as const, value: 1 }] }] }],
    };
    // deep: 3 levels (AND > AND > AND > leaf means depth=3 nested groups)
    expect(() => validateDataTableQuery({ ...minimalQuery, filters: deep }, baseConfig({ maxFilterDepth: 2 }))).toThrow(z.ZodError);
    expect(() => validateDataTableQuery({ ...minimalQuery, filters: deep }, baseConfig({ maxFilterDepth: 3 }))).not.toThrow();
  });

  it("throws ZodError when the total leaf count exceeds maxFilterCount", () => {
    const filters = {
      operator: "AND" as const,
      filters: [
        { field: "id", operator: "eq" as const, value: 1 },
        { field: "id", operator: "eq" as const, value: 2 },
        { field: "id", operator: "eq" as const, value: 3 },
      ],
    };
    expect(() => validateDataTableQuery({ ...minimalQuery, filters }, baseConfig({ maxFilterCount: 2 }))).toThrow(z.ZodError);
    expect(() => validateDataTableQuery({ ...minimalQuery, filters }, baseConfig({ maxFilterCount: 3 }))).not.toThrow();
  });

  it("throws ZodError when an in/notIn array exceeds maxInValues", () => {
    const filters = { operator: "AND" as const, filters: [{ field: "id", operator: "in" as const, value: [1, 2, 3, 4] }] };
    expect(() => validateDataTableQuery({ ...minimalQuery, filters }, baseConfig({ maxInValues: 3 }))).toThrow(z.ZodError);
    expect(() => validateDataTableQuery({ ...minimalQuery, filters }, baseConfig({ maxInValues: 4 }))).not.toThrow();
  });

  /**
   * The depth check runs BEFORE Zod's recursive `z.lazy()` parse, as an
   * iterative pass. If it ran after the parse, thousands of nested groups
   * would overflow the JS call stack before ever reaching the depth check and
   * produce a 500 (RangeError) instead of a 400.
   */
  it("a very deep (adversarial) filters body produces ZodError, NOT RangeError", () => {
    let deep: unknown = { field: "id", operator: "eq", value: 1 };
    for (let i = 0; i < 5000; i++) {
      deep = { operator: "AND", filters: [deep] };
    }
    let caught: unknown;
    try {
      validateDataTableQuery({ ...minimalQuery, filters: deep }, baseConfig());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
    expect(caught).not.toBeInstanceOf(RangeError);
  });

  it("throws ZodError when the search length exceeds maxSearchLength", () => {
    expect(() => validateDataTableQuery({ ...minimalQuery, search: "abcdef" }, baseConfig({ maxSearchLength: 5 }))).toThrow(z.ZodError);
    expect(() => validateDataTableQuery({ ...minimalQuery, search: "abcde" }, baseConfig({ maxSearchLength: 5 }))).not.toThrow();
  });
});

describe("validateDataTableQuery — page/offset upper bound", () => {
  const withPage = (page: number, pageSize = 20): DataTableQuery => ({ ...minimalQuery, pagination: { page, pageSize } });

  it("a page that produces an OFFSET beyond the safe integer range gives ZodError (400) instead of 500", () => {
    expect(() => validateDataTableQuery(withPage(1e300), baseConfig())).toThrow(z.ZodError);
    expect(() => validateDataTableQuery(withPage(Number.MAX_SAFE_INTEGER), baseConfig())).toThrow(z.ZodError);
  });

  it("with maxOffset, a page beyond the OFFSET is rejected and the page at the limit is accepted", () => {
    const config = baseConfig({ maxOffset: 1000 });
    expect(() => validateDataTableQuery(withPage(51), config)).not.toThrow(); // offset 1000
    expect(() => validateDataTableQuery(withPage(52), config)).toThrow(z.ZodError); // offset 1020
  });

  it("OFFSET is computed with the EFFECTIVE pageSize clamped to maxPageSize", () => {
    // pageSize 10,000 is requested but clamped to 500 → page 3 = offset 1000 (at the limit).
    expect(() => validateDataTableQuery(withPage(3, 10_000), baseConfig({ maxOffset: 1000 }))).not.toThrow();
  });

  it("the error path points to pagination.page", () => {
    try {
      validateDataTableQuery(withPage(1e300), baseConfig());
      expect.unreachable();
    } catch (err) {
      expect((err as z.ZodError).issues[0]!.path).toEqual(["pagination", "page"]);
    }
  });
});

describe("validateDataTableQuery — endpoint without a searchable field", () => {
  it("throws SearchNotSupportedError (NOT ZodError) when search is sent", () => {
    const config = baseConfig({
      fields: { id: { column: "id", type: "number", filterOperators: ["eq", "in"] } }, // no searchable field
    });
    expect(() => validateDataTableQuery({ ...minimalQuery, search: "x" }, config)).toThrow(SearchNotSupportedError);
  });

  it("empty/whitespace search passes silently (no search will be applied)", () => {
    const config = baseConfig({
      fields: { id: { column: "id", type: "number", filterOperators: ["eq", "in"] } },
    });
    expect(() => validateDataTableQuery({ ...minimalQuery, search: "   " }, config)).not.toThrow();
  });
});
