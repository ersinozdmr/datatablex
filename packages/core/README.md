# @datatablex/core

The wire contract of DataTableX: the query and result types, plus zero-dependency helpers shared by the frontend and the backend (`queryInMemory`, `isFilter`, `isFilterGroup`, `isDataTableResultEnvelope`, `filtersEqual`).

The package has **no runtime dependencies**, so it is safe to use both in the browser and on the server. It is usually consumed indirectly, through [`@datatablex/react`](https://www.npmjs.com/package/@datatablex/react) and [`@datatablex/fastify`](https://www.npmjs.com/package/@datatablex/fastify).

## Installation

```bash
npm install @datatablex/core
```

## Usage

```ts
import { queryInMemory } from "@datatablex/core";
import type { DataTableQuery, QueryableColumn } from "@datatablex/core";

interface Row {
  id: number;
  name: string;
}

const columns: QueryableColumn<Row>[] = [{ key: "name", type: "text", searchable: true }];

const query: DataTableQuery = {
  pagination: { page: 1, pageSize: 20 },
  sorting: [{ field: "name", direction: "asc" }],
  filters: null,
  search: "ada",
};

const result = queryInMemory(rows, query, columns); // DataTableResult<Row>
```

### `queryInMemory` is approximate

`queryInMemory` (and `createLocalDataSource`, which uses it) is meant for demos, tests and small client-side lists. The same query can return different results on `@datatablex/fastify` with PostgreSQL. When you move from a local prototype to REST, account for these differences:

| Topic                                         | `queryInMemory`                                                                                                                                                      | Fastify + PostgreSQL                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Text matching (`contains`, search)            | `String.prototype.toLowerCase`, independent of locale: `"İSTANBUL"` becomes `"i̇stanbul"` (a dotted i followed by a combining dot), so it does not match `"istanbul"` | `ILIKE`, with the collation and case rules of the database                   |
| Text sorting                                  | UTF-16 code unit order: `"Çorum"` sorts after `"Zonguldak"`                                                                                                          | Collation order (for example the Turkish alphabet under a `tr-TR` collation) |
| Dates and times                               | `Date.parse`: a value without a time zone is read as local time                                                                                                      | `timestamptz`/`date` and the `timezone` of the column                        |
| Invalid query                                 | Not validated; applied on a best-effort basis                                                                                                                        | Validated; a field or operator outside the allowlist is rejected with 400    |
| Limits (`maxPageSize`, `maxFilterDepth`, ...) | Not applied                                                                                                                                                          | Applied                                                                      |
| NULL ordering                                 | Same on both: `ASC` puts NULLs last, `DESC` puts them first                                                                                                          |                                                                              |

## Columns

The roles of a column are resolved in one place. `columnField(column)` returns the backend field (`field ?? key`; `null` marks a computed column). `columnValue(column, record)` returns the displayed value (the `accessor` field name or function, otherwise `record[field ?? key]`). `key` is the identity of the column.

## Filter trees

`filtersEqual(a, b)` compares two filter trees for logical equality (insensitive to the order of children, sensitive to duplicates), and `canonicalFilterKey(node)` returns the key that comparison is based on. `countFilterLeaves(node)` and `filterDepth(node)` count the same way as the `maxFilterCount` and `maxFilterDepth` validation in `@datatablex/fastify`, so a client can check the limits before sending a query.

`encodeFilterParam(filters)` turns a filter tree into the `f` URL parameter used by `syncWithUrl` (`base64url(UTF-8(JSON({ v: 1, filters })))`). `decodeFilterParam(value)` does the reverse and returns `null` for a value that is malformed, has an unknown version or has an invalid shape. Both are dependency-free and work in the browser and in Node 22 or later. A backend can, for example, build a link to a pre-filtered table:

```ts
const url = `/access-logs?f=${encodeFilterParam({ operator: "AND", filters: [{ field: "status", operator: "in", value: ["closed"] }] })}`;
```

## CSV

`csvCell` and `csvRow` (with `CSV_BOM` and `CSV_LINE_BREAK`) are the CSV rules shared by client-side and server-side export. Every cell is double-quoted as in RFC 4180. Text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` to prevent formula injection (CWE-1236). A `Date` is written in ISO 8601.

## Stability

Which parts of the API are stable, experimental or internal is described in [STABILITY.md](https://github.com/ersinozdmr/datatablex/blob/main/STABILITY.md).

## License

MIT
