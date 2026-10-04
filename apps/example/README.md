# `apps/example` — DataTableX Example Application

An example application that uses `@datatablex/fastify`, `@datatablex/react` and `@datatablex/antd` end to end on a real PostgreSQL database: a Fastify API plus a React and Ant Design client, covered by Playwright end-to-end tests.

**This is a demonstration. It is not meant to be deployed as it is.** The role is read from an `x-demo-role` header and there is no session or authentication. For that reason the server listens only on `localhost` by default and CORS is off. If `NODE_ENV=production` is set together with a non-loopback `HOST`, the server refuses to start unless `ALLOW_INSECURE_DEMO=1` is given.

## What it demonstrates

- **A sensitive field with role-based masking.** The schema is a single migration (`scripts/migrations/0001_init.ts`): an `access_logs` table and `access_logs_view`, which carries both the masked `national_id_masked` (`*******1234`) and the raw `national_id`. For the operator role, `nationalIdMasked` maps to the masked column; for the admin role it maps to the raw one. The raw `nationalId` field is `sensitive: true` and is open only to an exact match (`eq`): an operator who holds the full national ID number can find the record, but cannot search by part of it, because a substring filter or a global search would reveal every digit even though the value never appears in the response. A btree index on `national_id` serves the exact match.
- **Soft delete through `scope`.** The `deleted_at IS NULL` condition is applied in the `scope`, not in the view itself. `deleted_at` is passed through the view but never included in `fields`, so it never leaks into the response.
- **A `pg_trgm` GIN index** on `stadium_name`, the operational prerequisite for the `searchable` search and for the stadium `contains` filter. The screen has no global search box (the `searchable` prop is not passed): the search scans only the stadium name, so "Stadium contains" in the filter bar does the same job. The endpoint still supports search.
- **Column roles.** The national ID column is `{ key: "nationalId", accessor: "nationalIdMasked" }`: it filters on the raw field and displays the masked value. The hidden "Summary" column has `field: null` and is a computed column, which can be shown from the column panel.
- **Filter bar and URL sync.** The table is opened with `filterBar={{ mode: "advanced" }}`, and the "Advanced" button opens a panel that builds nested `AND` and `OR` groups. `syncWithUrl` is on: the query is carried in the URL, a filtered link can be shared, and the back button undoes a page change. "Filter" in a column header menu adds a rule to the bar, and `+ Add filter` lets you pick a field, a condition and a value (for example Stadium "does not contain"). The conditions offered come from the permissions in the endpoint meta (`GET /api/access-logs/query/meta`); the raw national ID offers only "equals".
- **A locked filter.** The "All records / Active only" switch passes an `active = true` pre-filter through `lockedFilters`. It appears in the bar as a summary that cannot be removed, it is not written to the URL, and "Clear all" does not touch it. It is not a security boundary; the soft-delete scope is applied in the backend with `scope`.
- **Server-side export.** CSV, Excel and PDF are produced on the server as a stream from a single snapshot (`pg-cursor`, `exceljs`, `pdfkit`). The PDF font is the Roboto in `assets/fonts/`. The limits are 10,000,000 rows for CSV, 1,000,000 for Excel and 100,000 for PDF. The "Export" panel in the toolbar asks for the scope first (this page, all filtered, or selected) and then the format. The table gets a ticket from `POST /api/access-logs/query/export/ticket`, and the browser downloads the file itself from `…/export/download`; for the admin role the address is `/api/access-logs/admin/export/*`, because a download cannot carry `x-demo-role`. CSV is written with a UTF-8 BOM and formula-injection escaping. The masked national ID is identity data, so it is `exportable: false` and left out of the export whitelist. The status and active labels are produced in the server `formatter`, and `onExport` logs every export to the console.
- **A deterministic seed.** The seed uses a PRNG with a fixed seed and a fixed reference time, so every run produces the same table. `visit_day` is the calendar day of the access in Istanbul. It also adds a record with a known national ID number, records that regress the day boundary (microseconds), a multi-page export case and a formula-injection (CWE-1236) test row.

## Roles

| Role                               | What it sees                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Operator (`x-demo-role: operator`) | The masked national ID (`*******1234`). It can find a record by the full number, but cannot search by part of it. |
| Admin (`x-demo-role: admin`)       | The unmasked national ID, with its own export address (`/api/access-logs/admin/export/*`).                        |

The client sets the header from the role selector at the top of the page. Changing the role remounts the table, so filters and the page are reset.

## Running it

```bash
# 1) Start Postgres (fixed port 55432, see docker-compose.yml)
pnpm --filter example db:up

# 2) Create .env
cp apps/example/.env.example apps/example/.env

# 3) Build the workspace packages (apps/example depends on them with workspace:*)
pnpm build

# 4) Migrate and seed (~50,000 rows). The seed TRUNCATEs access_logs; it runs only
#    on the datatablex_example database or one whose name ends in _test or _e2e
#    (set ALLOW_DESTRUCTIVE_SEED=1 on purpose for any other target).
pnpm --filter example db:migrate
pnpm --filter example db:seed

# 5) Development servers (API on :3000, Vite on :5173, /api is proxied)
pnpm --filter example dev
```

`pnpm --filter example db:down` stops the database.

## End-to-end tests (Playwright)

```bash
pnpm --filter example db:up
cp apps/example/.env.example apps/example/.env   # first time only
pnpm build
pnpm --filter example playwright:install
pnpm --filter example test:e2e   # migrate + seed + playwright test, in one command
```

The tests cover:

- URL sync: a link with nested filters, the back button and history entries, a malformed `f` parameter, and a page reload
- search, sorting and pagination
- the filter bar (adding and removing a "does not contain" rule)
- the advanced builder (`(Status = Closed OR Price ≥ 400) AND Stadium does not contain Park`)
- the status filter
- the national ID mask for operator and admin
- the national ID exact match, and at the API level the rejection of a partial query
- the microsecond boundary of the `datetime` day filter
- soft delete
- the locked filter ("Active only")
- server export at the API level (the row count equals the COUNT, and a field outside the whitelist is a 400)
- export in the UI (a multi-page "All filtered" CSV stream, the Excel and PDF file signatures, the download fallback)

In CI the same flow runs against the `postgres` service container of GitHub Actions; `docker-compose.yml` is only for LOCAL development.

## Environment variables

| Variable                 | Default            | Meaning                                                                                                                  |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`           | none (required)    | The PostgreSQL connection. The seed truncates only a database named `datatablex_example` or `*_test` / `*_e2e`.          |
| `PORT`                   | `3000`             | The API port (e2e: `3100`).                                                                                              |
| `HOST`                   | `localhost`        | The interface to listen on (IPv4 and IPv6 loopback).                                                                     |
| `CORS_ORIGIN`            | none (CORS is off) | A comma-separated list of allowed origins. Not needed in development, because the Vite proxy makes requests same-origin. |
| `ALLOW_INSECURE_DEMO`    | none               | `1`: allows a non-loopback `HOST` in production.                                                                         |
| `ALLOW_DESTRUCTIVE_SEED` | none               | `1`: lets the seed truncate a database outside the safe list.                                                            |

`GET /api/health` is the liveness endpoint and `GET /api/ready` is the readiness endpoint. Readiness runs `select 1` and returns 503 if the database cannot be reached; Playwright waits for it. On SIGINT or SIGTERM, Fastify stops accepting new connections, running requests finish, and the Kysely pool is closed.

## Out of scope

- **No JWT verification.** `getContext` and `authorize` return a fixed, unconditional context (see `src/server/accessLogsConfig.ts`). In a real integration both derive from a verified `preHandler`.

## Export benchmark

`pnpm --filter example bench:export` builds a `bench` table of 10 million rows and measures the server export. It does not run in CI.
