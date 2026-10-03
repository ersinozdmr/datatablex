import { describe, expect, it } from "vitest";
import { queryInMemory } from "../queryInMemory.js";
import type { DataTableQuery, QueryableColumn } from "../types.js";

interface Row {
  id: number;
  name: string;
  age: number;
  accessDate: string;
  active: boolean;
}

const rows: Row[] = [
  { id: 1, name: "Ahmet Yilmaz", age: 30, accessDate: "2026-01-01T10:00:00Z", active: true },
  { id: 2, name: "Mehmet Kaya", age: 25, accessDate: "2026-02-01T10:00:00Z", active: false },
  { id: 3, name: "Ayse Demir", age: 40, accessDate: "2026-03-01T10:00:00Z", active: true },
  { id: 4, name: "Fatma Sahin", age: 22, accessDate: "2026-04-01T10:00:00Z", active: false },
  { id: 5, name: "Ali Celik", age: 35, accessDate: "2026-05-01T10:00:00Z", active: true },
];

const columns: QueryableColumn<Row>[] = [
  { key: "id", type: "number" },
  { key: "name", type: "text", searchable: true },
  { key: "age", type: "number" },
  { key: "accessDate", type: "datetime" },
  { key: "active", type: "boolean" },
];

function baseQuery(overrides: Partial<DataTableQuery> = {}): DataTableQuery {
  return {
    pagination: { page: 1, pageSize: 20 },
    sorting: [],
    filters: null,
    ...overrides,
  };
}

/**
 * The backend `leafExpression` maps an empty `in`/`notIn` to the neutral
 * element (`eb.lit(false)` / `eb.lit(true)`), and that constant expression
 * does NOT look at whether the row is NULL. If the local engine applied the
 * NULL early return first, `notIn: []` would return a different set of rows
 * in the two modes.
 */
describe("queryInMemory — empty in/notIn matches the backend neutral element", () => {
  const withNull = [{ id: 1 }, { id: null as unknown as number }];

  it("notIn: [] returns ALL rows, including those carrying NULL", () => {
    const result = queryInMemory(withNull, baseQuery({ filters: { operator: "AND", filters: [{ field: "id", operator: "notIn", value: [] }] } }));
    expect(result.data).toHaveLength(2);
  });

  it("in: [] returns no rows", () => {
    const result = queryInMemory(withNull, baseQuery({ filters: { operator: "AND", filters: [{ field: "id", operator: "in", value: [] }] } }));
    expect(result.data).toHaveLength(0);
  });

  it("a non-empty notIn still drops the NULL row (SQL three-valued logic is preserved)", () => {
    const result = queryInMemory(withNull, baseQuery({ filters: { operator: "AND", filters: [{ field: "id", operator: "notIn", value: [99] }] } }));
    expect(result.data).toEqual([{ id: 1 }]);
  });
});

describe("queryInMemory — pagination", () => {
  it("paginates and reports total", () => {
    const result = queryInMemory(rows, baseQuery({ pagination: { page: 1, pageSize: 2 } }));
    expect(result.data).toHaveLength(2);
    expect(result.pagination).toEqual({ page: 1, pageSize: 2, total: 5 });
  });

  it("returns the second page", () => {
    const result = queryInMemory(rows, baseQuery({ pagination: { page: 2, pageSize: 2 } }));
    expect(result.data.map((r) => r.id)).toEqual([3, 4]);
  });

  it("clamps page and pageSize to a minimum of 1", () => {
    const result = queryInMemory(rows, baseQuery({ pagination: { page: 0, pageSize: -5 } }));
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.pageSize).toBe(1);
  });

  it("returns null total when skipCount is true", () => {
    const result = queryInMemory(rows, baseQuery({ skipCount: true }));
    expect(result.pagination.total).toBeNull();
  });
});

describe("queryInMemory — sorting", () => {
  it("sorts ascending by a numeric column", () => {
    const result = queryInMemory(rows, baseQuery({ sorting: [{ field: "age", direction: "asc" }] }), columns);
    expect(result.data.map((r) => r.id)).toEqual([4, 2, 1, 5, 3]);
  });

  it("sorts descending by a date column using type-aware comparison", () => {
    const result = queryInMemory(
      rows,
      baseQuery({ sorting: [{ field: "accessDate", direction: "desc" }] }),
      columns,
    );
    expect(result.data.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it("breaks ties using subsequent sort entries", () => {
    const tied: Row[] = [
      { id: 10, name: "B", age: 30, accessDate: "2026-01-01T00:00:00Z", active: true },
      { id: 11, name: "A", age: 30, accessDate: "2026-01-01T00:00:00Z", active: true },
    ];
    const result = queryInMemory(
      tied,
      baseQuery({
        sorting: [
          { field: "age", direction: "asc" },
          { field: "name", direction: "asc" },
        ],
      }),
      columns,
    );
    expect(result.data.map((r) => r.id)).toEqual([11, 10]);
  });
});

describe("queryInMemory — filtering", () => {
  it("applies a flat AND group", () => {
    const result = queryInMemory(
      rows,
      baseQuery({
        filters: {
          operator: "AND",
          filters: [
            { field: "active", operator: "eq", value: true },
            { field: "age", operator: "gte", value: 30 },
          ],
        },
      }),
      columns,
    );
    expect(result.data.map((r) => r.id)).toEqual([1, 3, 5]);
  });

  it("applies an OR group", () => {
    const result = queryInMemory(
      rows,
      baseQuery({
        filters: {
          operator: "OR",
          filters: [
            { field: "age", operator: "lt", value: 23 },
            { field: "age", operator: "gt", value: 39 },
          ],
        },
      }),
      columns,
    );
    expect(result.data.map((r) => r.id)).toEqual([3, 4]);
  });

  it("evaluates nested groups", () => {
    const result = queryInMemory(
      rows,
      baseQuery({
        filters: {
          operator: "AND",
          filters: [
            { field: "active", operator: "eq", value: true },
            {
              operator: "OR",
              filters: [
                { field: "age", operator: "eq", value: 30 },
                { field: "age", operator: "eq", value: 40 },
              ],
            },
          ],
        },
      }),
      columns,
    );
    expect(result.data.map((r) => r.id)).toEqual([1, 3]);
  });

  it("treats an empty AND group as matching everything, empty OR as matching nothing", () => {
    const allMatch = queryInMemory(rows, baseQuery({ filters: { operator: "AND", filters: [] } }));
    expect(allMatch.data).toHaveLength(5);

    const noneMatch = queryInMemory(rows, baseQuery({ filters: { operator: "OR", filters: [] } }));
    expect(noneMatch.data).toHaveLength(0);
  });

  it("evaluates between, in and isNull operators", () => {
    const between = queryInMemory(
      rows,
      baseQuery({ filters: { operator: "AND", filters: [{ field: "age", operator: "between", value: [25, 35] }] } }),
      columns,
    );
    expect(between.data.map((r) => r.id)).toEqual([1, 2, 5]);

    const inOp = queryInMemory(
      rows,
      baseQuery({ filters: { operator: "AND", filters: [{ field: "id", operator: "in", value: [1, 2] }] } }),
      columns,
    );
    expect(inOp.data.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("queryInMemory — search", () => {
  it("matches only searchable columns, case-insensitively", () => {
    const result = queryInMemory(rows, baseQuery({ search: "ayse" }), columns);
    expect(result.data.map((r) => r.id)).toEqual([3]);
  });

  it("matches nothing when columns are not provided", () => {
    const result = queryInMemory(rows, baseQuery({ search: "Ahmet" }));
    expect(result.data).toHaveLength(0);
  });

  it("matches nothing when no column is marked searchable", () => {
    const noSearchCols: QueryableColumn<Row>[] = columns.map((c) => ({ ...c, searchable: false }));
    const result = queryInMemory(rows, baseQuery({ search: "Ahmet" }), noSearchCols);
    expect(result.data).toHaveLength(0);
  });
});

/**
 * SQL three-valued logic. An explicit `null` and a field that is absent
 * altogether (`undefined`) must be treated the SAME way, otherwise the engine
 * becomes inconsistent with itself.
 */
describe("queryInMemory — NULL semantics", () => {
  interface NullableRow {
    id: number;
    age: number | null;
    name: string | null;
  }

  // #3 does not carry `age` at all, so it reads as undefined; #2 is an explicit null.
  const nullableRows: NullableRow[] = [
    { id: 1, age: 5, name: "Ahmet" },
    { id: 2, age: null, name: null },
    { id: 3, name: "Ayse" } as NullableRow,
  ];

  const nullableColumns: QueryableColumn<NullableRow>[] = [
    { key: "id", type: "number" },
    { key: "age", type: "number" },
    { key: "name", type: "text", searchable: true },
  ];

  const withFilter = (filter: DataTableQuery["filters"]) =>
    queryInMemory(nullableRows, baseQuery({ filters: filter }), nullableColumns).data.map(
      (r) => r.id,
    );

  const single = (
    field: string,
    operator: string,
    value?: unknown,
  ): DataTableQuery["filters"] =>
    ({ operator: "AND", filters: [{ field, operator, value }] }) as DataTableQuery["filters"];

  it.each([
    ["lt", 3],
    ["lte", 3],
    ["gt", 3],
    ["gte", 3],
    ["eq", 0],
    ["neq", 0],
  ])("no NULL row matches a `%s` comparison", (operator, value) => {
    const matched = withFilter(single("age", operator, value));
    expect(matched).not.toContain(2); // explicit null
    expect(matched).not.toContain(3); // missing field
  });

  it("`neq` leaves the NULL row OUT (in SQL, NULL <> x is NULL)", () => {
    expect(withFilter(single("age", "neq", 5))).toEqual([]);
  });

  it("`notIn` leaves the NULL row OUT", () => {
    expect(withFilter(single("age", "notIn", [99]))).toEqual([1]);
  });

  it("`in` and `between` leave the NULL row out", () => {
    expect(withFilter(single("age", "in", [5, 0]))).toEqual([1]);
    expect(withFilter(single("age", "between", [0, 100]))).toEqual([1]);
  });

  it("text operators leave the NULL row out", () => {
    expect(withFilter(single("name", "contains", "a"))).toEqual([1, 3]);
    expect(withFilter(single("name", "startsWith", ""))).toEqual([1, 3]);
  });

  it.each(["notContains", "notStartsWith", "notEndsWith"])(
    "`%s` leaves the NULL row OUT (in SQL, NULL NOT ILIKE x is NULL)",
    (operator) => {
      expect(withFilter(single("name", operator, "zzz"))).toEqual([1, 3]);
    },
  );

  it("negated text operators exclude case-insensitive matches", () => {
    expect(withFilter(single("name", "notContains", "HM"))).toEqual([3]);
    expect(withFilter(single("name", "notStartsWith", "a"))).toEqual([]);
    expect(withFilter(single("name", "notEndsWith", "SE"))).toEqual([1]);
  });

  it("`isNull`/`isNotNull` count an explicit null and a missing field the same", () => {
    expect(withFilter(single("age", "isNull"))).toEqual([2, 3]);
    expect(withFilter(single("age", "isNotNull"))).toEqual([1]);
  });

  it("search produces no match on a NULL field", () => {
    const result = queryInMemory(nullableRows, baseQuery({ search: "a" }), nullableColumns);
    expect(result.data.map((r) => r.id)).toEqual([1, 3]);
  });

  it("sorting follows the PostgreSQL default: ASC → NULLS LAST, DESC → NULLS FIRST", () => {
    const asc = queryInMemory(
      nullableRows,
      baseQuery({ sorting: [{ field: "age", direction: "asc" }] }),
      nullableColumns,
    ).data.map((r) => r.id);
    expect(asc[0]).toBe(1);
    expect(asc.slice(1).sort()).toEqual([2, 3]); // the two NULLs have no defined order between themselves

    const desc = queryInMemory(
      nullableRows,
      baseQuery({ sorting: [{ field: "age", direction: "desc" }] }),
      nullableColumns,
    ).data.map((r) => r.id);
    expect(desc[2]).toBe(1);
  });
});

describe("queryInMemory — column roles key/field/accessor", () => {
  interface Person {
    id: number;
    first: string;
    last: string;
    code: string;
    codeMasked: string;
  }
  const people: Person[] = [
    { id: 1, first: "Ada", last: "Smith", code: "111", codeMasked: "**1" },
    { id: 2, first: "Can", last: "Demir", code: "222", codeMasked: "**2" },
  ];
  const q = (overrides: Partial<DataTableQuery>): DataTableQuery => ({ pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null, ...overrides });

  it("search scans the accessor value (the displayed one)", () => {
    const columns = [{ key: "fullName", field: null, accessor: (p: Person) => `${p.first} ${p.last}`, searchable: true }];
    expect(queryInMemory(people, q({ search: "can dem" }), columns).data.map((p) => p.id)).toEqual([2]);
  });

  it("filter and sort type are looked up by field; key may differ", () => {
    const columns = [{ key: "identity", field: "id", type: "number" as const }];
    const result = queryInMemory(people, q({ sorting: [{ field: "id", direction: "desc" }], filters: { operator: "AND", filters: [{ field: "id", operator: "gt", value: 0 }] } }), columns);
    expect(result.data.map((p) => p.id)).toEqual([2, 1]);
  });

  it("filters by field, searches by accessor: the displayed masked value, the filter uses the raw field", () => {
    const columns = [{ key: "code", field: "code", accessor: "codeMasked" as const, searchable: true }];
    expect(queryInMemory(people, q({ filters: { operator: "AND", filters: [{ field: "code", operator: "eq", value: "222" }] } }), columns).data.map((p) => p.id)).toEqual([2]);
    expect(queryInMemory(people, q({ search: "222" }), columns).data).toHaveLength(0);
  });
});
