# @datatablex/fastify

The Fastify and Kysely query engine of DataTableX: an allowlist of fields and operators (`FieldConfig`), a one-line route setup (`datatableRoute`), and the translation from `DataTableQuery` to SQL (filters, search, safe sorting, pagination, camelCase projection).

## Installation

```bash
npm install @datatablex/fastify @datatablex/core fastify kysely
```

`@datatablex/core` is a regular dependency; `fastify` and `kysely` are **peer dependencies**.

| Peer      | Supported range     |
| --------- | ------------------- |
| `fastify` | `^5.0.0`            |
| `kysely`  | `>=0.28.17 <0.30.0` |

The lower bound of `kysely` is a security requirement: versions before `0.28.17` have reported SQL injection issues in JSON paths and in MySQL `sql.lit`. `0.29.x` requires Node 22.

API stability is described in [STABILITY.md](https://github.com/ersinozdmr/datatablex/blob/main/STABILITY.md).

## Usage

```ts
import { datatableRoute } from "@datatablex/fastify";
import type { FastifyInstance } from "fastify";
import { db } from "./db.js"; // Kysely<DB>

interface Ctx {
  userId: string;
  roles: string[];
}

export function registerAccessLogsRoute(app: FastifyInstance) {
  app.post(
    "/api/access-logs",
    datatableRoute(db, {
      table: "access_logs",
      primaryKey: "id",
      fields: {
        id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
        // The `@datatablex/react` datetime day filter is half-open: gte + lt.
        accessDate: {
          column: "access_date",
          type: "datetime",
          sortable: true,
          filterOperators: ["gte", "lt"],
        },
        stadiumName: {
          column: "stadium_name",
          type: "text",
          sortable: true,
          filterOperators: ["eq", "contains"],
          searchable: true,
        },
      },
      getContext: async (req): Promise<Ctx> => ({ userId: req.user.id, roles: req.user.roles }),
      authorize: (ctx) => ctx.roles.includes("viewer"),
    }),
  );
}
```

A request that sorts or filters by a field that is not defined in `fields` always gets a `400`: projection, sorting and filtering are resolved entirely through this allowlist. Use `scope` for a tenant or owner restriction or a soft-delete filter. `scope` returns only a boolean expression, which is added with AND to the WHERE of both the data query and the COUNT query:

```ts
scope: (eb, ctx) => eb.and([eb("tenant_id", "=", ctx.tenantId!), eb("deleted_at", "is", null)]),
// Authorization through another table: a subquery, not a JOIN (it does not change the row count or the total)
scope: (eb, ctx) =>
  eb.exists(eb.selectFrom("stadium_access").select("stadium_access.id").whereRef("stadium_access.stadium_id", "=", "access_logs_view.stadium_id").where("user_id", "=", ctx.userId)),
// Unrestricted role: say so explicitly
scope: (eb) => eb.lit(true),
```

`ExpressionBuilder` offers no ordering, limit, projection or join; use `stableSort` for the default ordering. A return value that is not an expression (`undefined`, `null`, a bare subquery) raises `InvalidScopeError` (500) before the query runs.

## Validation of filter values

The value of every leaf filter that passes the allowlist is also validated with a Zod schema derived from the `type` of the field:

| `type`     | Accepted wire value                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`     | `string`                                                                                                                                        |
| `number`   | a finite `number` (not a numeric string such as `"12"`)                                                                                         |
| `boolean`  | `boolean` (not `"true"`)                                                                                                                        |
| `enum`     | `string` \| `number`                                                                                                                            |
| `date`     | a calendar day only, `YYYY-MM-DD` (a time or timezone is rejected)                                                                              |
| `datetime` | ISO 8601 with both a time and an explicit timezone (`2026-09-03T14:00:00Z`, `...+03:00`); a day only, or a time without a timezone, is rejected |

Epoch numbers and locale formats (`03.09.2026`) are rejected for both `date` and `datetime`; days that do not exist on the calendar (`2026-02-31`) are rejected too.

**A `datetime` field must be a `timestamptz`.** The wire value is an offset-qualified INSTANT (`2026-09-02T21:00:00.000Z`; the client converts "that day" to UTC according to the time zone of the column). On a PostgreSQL `timestamp without time zone` column, a literal's time zone information is SILENTLY dropped and the value is compared as if it were local time: for Istanbul, a "that day" filter shifts by 3 hours and the query returns a wrong set of rows instead of an error. The library cannot enforce this, because it cannot see the DB type of the column at boot. If you have a `timestamp` column, either (1) derive a `timestamptz` in the view with `col AT TIME ZONE 'Europe/Istanbul'` and map the field to it, or (2) use `parseValue` to convert the value to local time in the target time zone:

```ts
accessDate: {
  column: "access_date", // timestamp without time zone, Istanbul local time
  type: "datetime",
  filterOperators: ["gte", "lt"],
  // Wire: an absolute instant (Z / offset); column: Istanbul wall-clock time. The result is a STRING ("2026-09-03 00:00:00"):
  // do not return a `Date`, the driver would serialize it in the process time zone.
  parseValue: (raw) => new Date(String(raw)).toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }),
},
```

`parseValue` runs after validation; it is not needed when the column is a `timestamptz`.

Every element of a `between`/`in`/`notIn` array is validated separately; `isNull`/`isNotNull` carry no value and are exempt. The order is binding: **the allowlist is the primary gate** (an undefined field or operator never reaches the type check and gets a `FieldNotAllowedError`), and **`parseValue` runs after this validation**. It converts a wire value that already matches its type to the DB type; it does not replace the validation.

## Sensitive fields (`sensitive`)

A field being absent from `select` does not mean its value is protected: if a `contains` or range filter, the global search, or sorting can run on it, the value can be recovered piece by piece by asking "did any results come back?". `sensitive: true` prevents this at boot time:

```ts
nationalId: { column: "national_id", type: "text", sensitive: true, filterOperators: ["eq"] },
```

- The only allowed operators are `eq`, `isNull` and `isNotNull` (`in`/`notIn` are not allowed: `in` leaves combined with `OR` would test thousands of guesses per request); `searchable` and `sortable` cannot be enabled. The column of the field cannot be used in `stableSort` either: a tiebreaker would leak the order of the values too.
- A query can contain at most **one** sensitive leaf, and it must be a direct child of the root `AND` group (not under an `OR` or a nested group): one guess per request. Otherwise the response is a 400 (`validation`).
- The rule is tied to the **column**: another field key that maps the same column (an alias) is subject to the same restrictions. To include the alias in the projection or in `export.fields` (for example to show the value unmasked to an administrator), set `declassify: true`; the flag does not lift the restrictions. The error message names both keys.
- If a **masked derivative** of the value (for example the last 4 digits) is exposed, the guess space shrinks considerably (about 9·10⁴ for a national ID number); in that case do not put the field in `fields` at all. A per-request rate limit at the API gateway is required against brute force.
- The field cannot appear in an explicit `select`; when `select` is not given, it is not in the default projection either. The `primaryKey` cannot be sensitive.
- Fields with short values (a PIN, a birth year) can be guessed even with `eq`: do not put them in `fields` at all.

## Error body

Every 4xx/5xx JSON response has the `DataTableErrorBody` shape of `@datatablex/core`: `message` (in the language of the server, meant for developers) and a machine-readable `code` (`DataTableErrorCode`). The UI uses the code to show a text in its own language (`@datatablex/antd` `locale.errorMessages`); for an unknown code it shows `message`. The codes are: `unsupported_protocol`, `forbidden`, `export_forbidden`, `validation` (`details` carries the issues), `field_not_allowed`, `invalid_filter_value`, `search_not_supported`, `export_disabled`, `export_too_large` (`total`, `maxRows`), `export_busy` (`maxConcurrent`), `ticket_gone`, `export_failed`, `options_too_large`, `internal_error`. An unexpected error (one that carries no `statusCode`: a database error, `InvalidScopeError`, a plain `Error` from `getContext` or `authorize`) is returned as a 500 `internal_error` with a constant message; the original error reaches the Fastify error log and your `setErrorHandler` in the `cause` of a `DataTableInternalError`, and no detail leaks to the client. An error that carries a `statusCode` (for example a 401 from `getContext`) passes through unchanged. If a non-Fastify backend conforms to the same shape, `@datatablex/react` and `@datatablex/antd` handle its errors the same way. The errors of the native download route are plain text (a browser download cannot read JSON).

## Protocol version

The `createRestDataSource` of `@datatablex/react` adds an `x-datatablex-protocol: 1` header to every request. `datatableRoute` rejects a version it does not support, before `getContext` and `authorize`, with a `400` whose body is `{ error: "Unsupported Protocol", code: "unsupported_protocol", message, supported: [1] }` (`UnsupportedProtocolError`); a request without the header is treated as version 1. The supported versions are exported as `SUPPORTED_PROTOCOL_VERSIONS` and reported in the `protocol` field of the meta response.

## Meta route

The handler returned by `datatableRoute` also carries a `meta` handler that serves the effective limits and the field allowlist of the endpoint. It goes through the same `getContext`/`authorize` gate as the query:

```ts
const accessLogs = datatableRoute(db, config);
app.post("/api/access-logs/query", accessLogs);
app.get("/api/access-logs/query/meta", accessLogs.meta);
```

The response has the shape `{ version: 1, protocol: { version, supported }, primaryKey, limits, fields }`. `limits` carries `maxPageSize`, `maxFilterDepth`, `maxFilterCount`, `maxInValues`, `maxSearchLength`, `maxSortCount` and `maxOffset` (`null` if not given), with the defaults applied; `fields` carries `type`, `filterOperators`, `sortable` and `searchable` for each field. The DB column mapping, `parseValue` and the `sensitive` flag are not in the response. The same output can also be produced directly with `describeDataTableEndpoint(config)`. The meta is only a convenience for clients; the security boundary is query validation.

## Filter options (`options`)

> **Experimental** (`@experimental`): `FieldConfig.options`, `FieldConfig.maxOptions` and the `options` route handler may change in any release while the package is in 0.x. See [STABILITY.md](https://github.com/ersinozdmr/datatablex/blob/main/STABILITY.md).

The filter options (value and label) of an enum field can come from the server; the client column does not need an `options` of its own. Provide a static list, or a resolver that is called with `ctx` on every request, and register the route:

```ts
const config = {
  // ...
  fields: {
    status: {
      column: "status_id",
      type: "enum",
      filterOperators: ["in", "notIn"],
      // Tenant/role filtering happens here, next to `scope`.
      options: async (ctx) => {
        const rows = await db
          .selectFrom("statuses")
          .select(["id", "name"])
          .where("tenant_id", "=", ctx.tenantId!)
          .orderBy("name")
          .execute();
        return rows.map((row) => ({ label: row.name, value: row.id }));
      },
    },
  },
};
const accessLogs = datatableRoute(db, config);
app.get("/api/access-logs/query/options/:field", accessLogs.options);
```

- The field name is read from the `:field` path parameter. The route goes through the same gate as the query (protocol, `getContext`, `authorize`).
- The response is `{ version: 1, options: [{ label, value }] }` with `cache-control: no-store`. The meta reports `hasOptions: true` for a field that defines options; the list itself is not in the meta.
- **The package does not cache the result:** the resolver is called on every request. A cache that does not depend on `ctx` would hand one tenant's list to another. The client (`createRestDataSource`) fetches the list once per field; if you need a shared cache, build it inside the resolver, with a key that covers `ctx` (for example `tenantId`).
- If `maxOptions` (per field, default 500) is exceeded, the response is not truncated: it is a `500 options_too_large`, and the detail goes to the server log. An option list is not the right tool for a field with very high cardinality.
- An unknown field, or a field that does not define `options`, gets `400 field_not_allowed`. If the resolver throws, the response is `500 internal_error` (no detail goes to the client).
- Boot rules: `options` can only be given on a field with `type: "enum"`, with `in` or `notIn` enabled, that is not `sensitive`; a static list is validated at startup.
- **It is not a security boundary:** filter values are not validated against this list. Use `scope` for rows the user must not see.

## Server export (`export`)

> **Experimental** (`@experimental`): `export.ticketStore` and `export.onExport` may change in any release while the package is in 0.x. See [STABILITY.md](https://github.com/ersinozdmr/datatablex/blob/main/STABILITY.md).

An opt-in streaming route for CSV, XLSX and PDF. Rows are read from a single snapshot (no drift between pages), streamed from a cursor in batches, and there is no `OFFSET` scan. No new rows are read from the cursor while the writer's buffer is full: server memory does not depend on the number of rows or on the speed of the client.

```ts
import Cursor from "pg-cursor";

// Prerequisite: Kysely's PostgresDialect must be set up with a cursor.
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool, cursor: Cursor }) });

const accessLogs = datatableRoute(db, {
  ...config,
  export: {
    fields: ["id", "accessDate", "stadiumName", "status"], // a subset of the projection; the whole projection if not given
    authorize: (ctx) => ctx.roles.includes("access_logs:export"), // runs after authorize
    formats: ["csv", "excel", "pdf"], // default ["csv"]; excel needs exceljs, pdf needs pdfkit (optional peers)
    maxRows: { csv: 10_000_000, excel: 1_000_000, pdf: 100_000 }, // can also be a number; the default is 100,000 for every format; a request above it gets a 413
    pdf: { font: { regular: "fonts/Roboto-Regular.ttf", bold: "fonts/Roboto-Medium.ttf" } }, // required when PDF is enabled
    formatter: (field, value) => (field === "status" ? STATUS_LABELS[value as string] : value),
    onExport: (event) => audit.write(event), // completed | cancelled | failed, row count, fields, duration (the event carries the query and ctx; see the note below)
    statementTimeoutMs: 60_000,
    idleTimeoutMs: 60_000, // the export is cut if the client reads nothing for this long (default 60,000)
    maxDurationMs: 30 * 60_000, // total duration, opening included; default 10 minutes, Infinity for no limit; a large maxRows needs this too
  },
});
// The client uses a ticket plus a native download; register both routes side by side under the export address.
app.post("/api/access-logs/query/export/ticket", accessLogs.exportTicket);
app.get("/api/access-logs/query/export/download", accessLogs.exportDownload);
```

**Ticket and download.** A native browser download (the file never enters browser memory) cannot carry headers such as `Authorization`. That is why there are two steps:

1. `POST <export>/ticket` runs the same gates and validation as `export`, an early COUNT (413) and the concurrency check (429). The response is `{ ticket, total, filename, expiresAt }`: a single-use ticket that lives for `ticketTtlMs` (default 60 seconds).
2. `GET <export>/download?ticket=...` takes and deletes the ticket atomically; if it is missing the response is a 410. `getContext` is not called, and `ctx` comes from the ticket; the request is validated again with the config of this route, and `authorize`/`export.authorize` run again. Error responses are also returned as an `attachment` (`export-error.txt`): the browser does not leave the application to open an error page, and the download simply appears to fail.

- **The audit record may carry sensitive data:** the `onExport` event carries `ctx` and the applied query, and the query may contain the value searched on a `sensitive` field (for example a queried national ID number). When writing to a persistent record, mask the filter values or store only the field and operator.
- **Ticket store:** the default is in-process memory (`createMemoryTicketStore({ maxTickets })`, 1,000 pending tickets by default; when it is full, the ticket route returns 429 `export_busy` with `Retry-After`; every ticket holds the raw request body). Ticket issuance is NOT limited per user or session: a per-user rate limit is the job of the API gateway. With more than one server instance, a ticket can land on a different instance; provide a shared store with `export.ticketStore` (`set(id, data, ttlMs)` and an atomic `take(id)`, for example Redis `SET PX` + `GETDEL`). In that case `ctx` must be JSON-serializable.
- **Concurrency:** `export.maxConcurrent` (default 4) is the number of exports that are opening or streaming at the same time, per process and per endpoint: the slot is reserved before the transaction is opened and given back when the stream ends (or when the opening fails). While it is full, the ticket route returns 429 with `Retry-After: 5`; the download route returns 429 too.
- **A client that does not read, and the time limits:** backpressure keeps server memory independent of the speed of the client, but while an export runs the following stay open: a `REPEATABLE READ` snapshot (VACUUM cannot advance and the database bloats), a shared lock on the table (an `ALTER TABLE` from a migration waits for it, and queries to that table queue up behind the migration), a pool connection, and a `maxConcurrent` slot. Because the duration is set by the read speed of the client and not by the server, there are two limits:
  - `export.idleTimeoutMs` (default 60,000): if the client pulls no chunk for this long, the export is cut (`ExportTimeoutError`, `kind: "stalled"`). Chunks are about 64 KB, so this is an implicit lower bound on speed (about 1 KB/s): a client that reads more slowly is caught too.
  - `export.maxDurationMs` (default 600,000 = 10 minutes; `Infinity` for no limit; a finite value can be at most 2,147,483,647): the total duration of the export, opening (COUNT, first cursor read) included (`kind: "duration"`). If it is exceeded during the opening, the download returns 500 `export_failed`; because `statement_timeout` is set to the remaining time, the query also stops in the database. The default was chosen for the default `maxRows` (100,000): **if you raise `maxRows`, raise this too** (a 1.5 GB CSV takes about 10 minutes to download at 20 Mbps; a download that is cut off appears in the browser only as "failed").

  In both cases the transaction is rolled back and the event is `failed`. Behind a reverse proxy that buffers (for example nginx `proxy_buffering`), the server sees a proxy that reads fast: protection against a slow client becomes the proxy's job, and `maxDurationMs` still bounds the transaction. The package does not set `idle_in_transaction_session_timeout` on the database role by default: with a client that reads but is slow (the producer waits for the buffer to drain, so the session sits idle inside the transaction) it would kill the connection by mistake; if you set it, keep it larger than `maxDurationMs`.

- **Capacity:** production runs on the main thread of Node and is bound to a single core: concurrent exports do not increase memory, but they share the core, and each one takes longer. To add capacity, increase the number of processes or instances.
- **Measurements** (16 cores): CSV 10M rows 119 s, XLSX 1M rows 41 s, PDF 100K rows 73 s; server memory stays under about 300 MB in each case, independent of the number of rows. The producer yields to the event loop every 20 ms (p99 <= 30 ms); the libraries of the enabled formats are loaded when `datatableRoute` is set up.
- The `export` block of the meta reports that these two routes are registered; the client uses it to choose the server path. A setup that forgets to register the routes gets a 404 on the first export.

The request is: `{ query: { sorting, filters, search?, pagination? }, format, scope?, keys?, columns: [{ field, title }], filename?, title? }`. The query goes through the same validation as `/query`; `columns[].field` must be in the export allowlist and `format` must be in `export.formats` (otherwise 400). The response carries `Content-Disposition` (unpaired Unicode surrogates in the file name become U+FFFD; the header is built before the source is opened) and an `x-datatablex-total` header with the number of rows in the snapshot. COUNT and the stream run in the same `REPEATABLE READ` read-only transaction, so the header is exactly equal to the number of rows in the file.

| Scope (`scope`)         | Query                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allFiltered` (default) | Filters, search, sorting; no pagination                                                                                                                                  |
| `currentPage`           | The same, plus `query.pagination` (required, clamped to `maxPageSize`)                                                                                                   |
| `selected`              | `scope` plus the primary key `in keys` (at most `maxSelectedKeys`, default 10,000; of the type of the key); the client's filters and search are ignored, sorting is kept |

| Format  | Produced with                                                            | Notes                                                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `csv`   | BOM + header + rows, the `csvCell` rule of core                          |                                                                                                                                                                                                                                                                                              |
| `excel` | the `exceljs` streaming writer, a single sheet, a bold frozen header row | Numbers, dates and booleans are typed; the numeric text of a `number` field (PostgreSQL `numeric`) becomes a number, and the `YYYY-MM-DD` text of a `date` field becomes UTC midnight. Object values are converted to text (no formula injection). `maxRows.excel` can be at most 1,048,575. |
| `pdf`   | `pdfkit`, landscape A4 above 4 columns, 8 pt                             | A header row on every page and a page number at the bottom; a cell wraps to at most 3 lines, and the rest is cut with `…`. The built-in PDF fonts do not include Turkish characters (for example the dotless i and the s-cedilla), so `pdf.font` is required.                                |

- If `export` is not given, `handler.exportTicket` and `handler.exportDownload` return 404 (`export_disabled`); if it is given, the meta reports `export: { formats, fields }`. `formats` carries the enabled formats and their row ceilings (`{ csv: 100000, excel: 100000 }`); a format that has no key is not produced.
- `exceljs` and `pdfkit` are optional peers: install only the package of the format you enable. If the package of an enabled format is not installed, the application fails at startup.
- If the client closes the connection, the cursor is closed and the transaction is rolled back; `onExport` receives `cancelled`. The event carries `format` and `scope`.
- If you give a large `maxSelectedKeys` for the `selected` scope, also raise the Fastify `bodyLimit` (default 1 MB).
- On a dialect without a cursor, the response is an `ExportStreamingUnavailableError` (500) with an explanatory message.
- The cell value is decided on the server by `formatter`; the `exportValue` of the client does not run on this path.

## Direct use

The production path is `datatableRoute`. For integrations that build their own route layer, `assertValidEndpointConfig(config)` is exported; it can be called to validate the config at startup. The internal parts (`validateDataTableQuery`, `handleDataTableQuery`, `openDataTableExport`, `filterExpression` ...) are not exported from the package root: the `getContext`/`authorize` gate exists only in `datatableRoute`, and using the internal parts directly bypasses it.

## Sorting

`sorting` cannot carry the same field twice (400). If `stableSort` is not given, the `primaryKey` column is the only tiebreaker; if it is given and does not include the primary key, the primary key is appended at the end. If the primary key is given explicitly, it must be last, otherwise `datatableRoute` throws at boot. A column of a sensitive field and a repeated column are rejected too.

## Pagination limits

`maxPageSize` (default 500) caps the number of rows returned. All the limits (`maxPageSize`, `maxFilterDepth`, `maxFilterCount`, `maxInValues`, `maxSearchLength`, `maxSortCount`) must be positive safe integers at boot, and `maxOffset` a non-negative safe integer; otherwise `datatableRoute` throws. `maxOffset` (optional) bounds `(page - 1) * pageSize`; even when it is not given, an OFFSET that exceeds the safe integer range is rejected with a 400.

The wire types (`DataTableQuery`, `DataTableResult`, the error body and the endpoint metadata) are defined in [`@datatablex/core`](https://www.npmjs.com/package/@datatablex/core).

## License

MIT
