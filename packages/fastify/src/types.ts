import type { FastifyReply, FastifyRequest } from "fastify";
import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import type { DataTableFieldOption, DataTableServerExportFormat } from "@datatablex/core";

/**
 * The minimum every integration's `Ctx` must carry. `getContext` does NOT
 * verify it; it only maps the already verified `req.user`. Signature checking
 * happens in a separate `preHandler` (for example `@fastify/jwt`).
 */
export interface BaseCtx {
  /** Identifier of the authenticated user. */
  userId: string;
  /** Roles of the authenticated user. */
  roles: string[];
  /** Tenant of the authenticated user, for multi-tenant integrations. */
  tenantId?: string;
}

/**
 * The VALIDATION category of a field. It is deliberately not the same enum as
 * the frontend's `DataTableColumn.type`: `time`/`currency`/`custom` are
 * *display* categories, and on the backend they correspond to `datetime`/
 * `number`/(the underlying base type). Each value is also a contract on the
 * WIRE SHAPE: `validateDataTableQuery` validates filter values according to
 * this type.
 */
export type FieldType = import("@datatablex/core").DataTableFieldType;

/** The ceiling applied when `FieldConfig.maxOptions` is not given — the same as the default of `maxInValues`. */
export const DEFAULT_MAX_OPTIONS = 500;

/**
 * Allowlist entry for one field of an endpoint: which DB column it maps to,
 * its validation type, and which operations clients may run on it.
 *
 * @example
 * ```ts
 * const status: FieldConfig<DB, "orders"> = {
 *   column: "status",
 *   type: "enum",
 *   sortable: true,
 *   filterOperators: ["eq", "in", "notIn"],
 * };
 * ```
 */
export interface FieldConfig<DB, TB extends keyof DB, Ctx extends BaseCtx = BaseCtx> {
  /** The real DB column — type-safe, narrowed to `keyof DB[TB]`. */
  column: keyof DB[TB] & string;
  /** Validation category of the field; filter values are validated against it. */
  type: FieldType;
  /** Whether clients may sort by this field. */
  sortable?: boolean;
  /** Allowed operators, nullary ones included; none if empty or not given. */
  filterOperators?: import("@datatablex/core").FilterOperator[];
  /** Whether the global `search` also scans this field — allowed ONLY on `type: "text"` fields. */
  searchable?: boolean;
  /**
   * JSON to DB type conversion (for example an ISO 8601 string to a Date). It
   * MUST THROW on INVALID input — silently returning Invalid Date/NaN is
   * forbidden, otherwise that value goes into the query as it is.
   *
   * It does NOT REPLACE the wire shape of `type`; it runs AFTER it: the value
   * is first validated against `type` in `validateDataTableQuery` (a `number`
   * field takes a number, a `date`/`datetime` field takes an ISO 8601 string),
   * and `parseValue` only converts that validated wire value to the DB type.
   */
  parseValue?: (raw: unknown) => unknown;
  /**
   * Marks a sensitive field (for example a national ID number). Its VALUE must
   * not reach the client by any route — not only through the projection, but
   * also through PREDICATES.
   *
   * A client that can run a `contains`/`startsWith`/range filter or the global
   * search on a field can recover the value piece by piece by observing
   * whether results come back, even if that field is not in `select` at all (a
   * "predicate oracle"). This flag makes that impossible at boot time with an
   * ALLOWLIST:
   * - `filterOperators` may only be `eq`, `isNull`, `isNotNull` (`in`/`notIn`
   *   are NOT allowed: `in` leaves combined with `OR` would test thousands of
   *   guesses per request at once);
   * - `searchable` and `sortable` cannot be enabled (sorting also leaks the
   *   order of the value);
   * - the field cannot appear in an explicit `select` list, and when `select`
   *   is not given it is NOT INCLUDED in the default projection;
   * - it cannot be the `primaryKey` (the primary key is returned in every
   *   response);
   * - any other field key that maps the SAME COLUMN (an alias) is subject to
   *   the same rules (they are evaluated at the column level) and needs
   *   `declassify: true` to enter the projection/export.
   *
   * REQUEST rule (`validateDataTableQuery`): a query may contain at most ONE
   * sensitive leaf, and that leaf must be a direct child of the root `AND` (it
   * cannot be under an `OR` or a nested group) — the number of guesses per
   * request is 1.
   *
   * `eq` is deliberately left open: an exact value match lets someone who
   * already knows the value find the record. The guess space (for example an
   * 11-digit identifier) is not suited to brute force, but the number of
   * guesses is not a limit BY ITSELF: limiting brute force is the job of the
   * API gateway (a per-request rate limit). If a masked derivative of the
   * sensitive value (for example the last 4 digits) is exposed, the guess
   * space shrinks considerably — in that case do not put the field in `fields`
   * at all. For fields with short values (for example a 4-digit PIN) this flag
   * is not sufficient on its own.
   */
  sensitive?: boolean;
  /**
   * States that ANOTHER field key mapping a sensitive column (an alias)
   * deliberately exposes that column's value in the response/export (for
   * example to show it unmasked to an administrator). It is meaningful only on
   * a field that shares its `column` with a sensitive column and is not
   * `sensitive` itself; anywhere else it is a boot error. The alias's
   * operator/`searchable`/`sortable` restrictions are NOT lifted by
   * `declassify`.
   */
  declassify?: boolean;
  /**
   * Filter options of the field: a static list, or a resolver called with
   * `ctx` on every request. When given, the meta reports `hasOptions` for the
   * field and the `handler.options` route serves the list; a client column
   * that has no hand-written `options` builds its filter from this list.
   *
   * It can only be given on a field with `type: "enum"`, with the `in` or
   * `notIn` operator enabled, that is not `sensitive` (validated at boot). The
   * package does not write a distinct query and does NOT CACHE the result: the
   * resolver is called on every request. Tenant/role filtering is done here
   * through `ctx`; if a shared cache is needed, build it inside the resolver
   * with a key that includes `ctx`.
   *
   * This is NOT A SECURITY BOUNDARY: filter values are not validated against
   * this list.
   *
   * @experimental May change in any release while the package is in 0.x.
   */
  options?: DataTableFieldOption[] | ((ctx: Ctx) => DataTableFieldOption[] | Promise<DataTableFieldOption[]>);
  /**
   * Maximum length of the `options` list. If the resolver returns a longer
   * list the response is not truncated: `OptionsTooLargeError` (500,
   * `options_too_large`) is raised. An option list is not the right tool for
   * fields with very high cardinality.
   *
   * @default 500 (`DEFAULT_MAX_OPTIONS`)
   * @experimental May change in any release while the package is in 0.x.
   */
  maxOptions?: number;
}

/**
 * Configuration of one data table endpoint: the table, the allowlisted
 * fields, authorization, the row scope, and the limits. Passed to
 * `datatableRoute` and `describeDataTableEndpoint`; invalid configs are
 * rejected at boot.
 *
 * @example
 * ```ts
 * const config: DataTableEndpointConfig<DB, "orders", AppCtx> = {
 *   table: "orders",
 *   primaryKey: "id",
 *   fields: {
 *     id: { column: "id", type: "number", sortable: true, filterOperators: ["eq", "in"] },
 *     customer: { column: "customer_name", type: "text", searchable: true, filterOperators: ["contains"] },
 *   },
 *   getContext: (req) => ({ userId: req.user.id, roles: req.user.roles }),
 *   authorize: (ctx) => ctx.roles.includes("sales"),
 *   scope: (eb, ctx) => eb("tenant_id", "=", ctx.tenantId!),
 *   export: { formats: ["csv"] },
 * };
 * ```
 */
export interface DataTableEndpointConfig<DB, TB extends keyof DB & string, Ctx extends BaseCtx = BaseCtx> {
  /** A real table, OR a DB view that covers the JOINs. */
  table: TB;
  /** Keys are the wire/response field names (camelCase), values are the DB column mappings. */
  fields: Record<string, FieldConfig<DB, TB, Ctx>>;
  /** MUST BE A KEY OF `fields` (validated at boot) — an ordinary allowlisted field. */
  primaryKey: string;
  /**
   * A subset of the `fields` keys (a `sensitive` field cannot be included) — if not given, all NON-`sensitive` keys of `fields`; `primaryKey` is always added automatically.
   *
   * @default every non-`sensitive` key of `fields`
   */
  select?: string[];
  /** Required — the mapping from `req` to `Ctx` is not implicit; `req` must carry the verified `req.user`. */
  getContext: (req: FastifyRequest) => Ctx | Promise<Ctx>;
  /**
   * Row scope: tenant/ownership, soft-delete. The expression it returns is
   * added to the query's WHERE with AND; it is applied to every query,
   * COUNT included, before the filter and the search.
   *
   * It can only return a boolean expression — `ExpressionBuilder` offers no
   * `orderBy`, `limit`, `select` or `join`. If authorization through another
   * table is needed, use a subquery such as `eb.exists(eb.selectFrom(...)...)`:
   * it does not change the row count, so `total` stays correct. For an
   * unrestricted role return `eb.lit(true)` explicitly; a return value that is
   * not an expression is rejected with `InvalidScopeError` (500). Use
   * `stableSort` for the default ordering.
   */
  scope?: (eb: ExpressionBuilder<DB, TB>, ctx: Ctx) => Expression<SqlBool>;
  /** REQUIRED — makes failing open impossible. */
  authorize: (ctx: Ctx) => boolean | Promise<boolean>;
  /**
   * Tiebreaker ordering that keeps pagination stable.
   *
   * @default [{ column: fields[primaryKey].column, direction: "asc" }]
   */
  stableSort?: Array<{ column: keyof DB[TB] & string; direction: "asc" | "desc" }>;
  /**
   * Maximum page size — EVERY request, export included, is subject to it.
   *
   * @default 500
   */
  maxPageSize?: number;
  /**
   * Nesting depth of `FilterGroup`.
   *
   * @default 3
   */
  maxFilterDepth?: number;
  /**
   * Total number of leaf `Filter`s across all groups.
   *
   * @default 50
   */
  maxFilterCount?: number;
  /**
   * Number of elements in an `in`/`notIn` array.
   *
   * @default 500
   */
  maxInValues?: number;
  /**
   * Character length of the `search` string.
   *
   * @default 200
   */
  maxSearchLength?: number;
  /**
   * Number of elements in the `sorting` array.
   *
   * @default 3
   */
  maxSortCount?: number;
  /**
   * Upper bound for `(page - 1) * pageSize` — if not given, only the safe
   * integer bound (`Number.MAX_SAFE_INTEGER`) applies. PostgreSQL SCANS the
   * rows up to the `OFFSET`; endpoints that want to limit this cost axis, which
   * `maxPageSize` does not cover (very large tables), set a value. A request
   * that exceeds it gets a 400. The lasting solution for deep pagination is
   * keyset/cursor pagination, which is not implemented yet.
   *
   * @default undefined (only the safe integer bound applies)
   */
  maxOffset?: number;
  /**
   * Server-side export. When given (an empty object included), the
   * `handler.exportTicket` and `handler.exportDownload` routes are enabled and
   * the meta reports the `export` field; when not given, both return 404.
   * Rows are streamed from a single snapshot (REPEATABLE READ, read-only
   * transaction) with Kysely `.stream()`; this requires `PostgresDialect` to be
   * set up with `cursor` (`pg-cursor`).
   */
  export?: DataTableExportConfig<Ctx>;
}

/**
 * Server-side export settings of an endpoint: exported fields, formats, row
 * ceilings, concurrency, the ticket store, timeouts and the audit hook.
 *
 * @example
 * ```ts
 * const exportConfig: DataTableExportConfig<AppCtx> = {
 *   formats: ["csv", "excel"],
 *   maxRows: { csv: 100_000, excel: 50_000 },
 *   authorize: (ctx) => ctx.roles.includes("exporter"),
 *   onExport: (event) => audit.log(event.outcome, event.rowCount),
 * };
 * ```
 */
export interface DataTableExportConfig<Ctx extends BaseCtx = BaseCtx> {
  /**
   * Fields open to export — a subset of the projection (`select`, or all
   * non-`sensitive` fields if `select` is not given), validated at boot. If not
   * given, the whole projection. A sensitive field is never exported.
   *
   * @default the whole projection
   */
  fields?: string[];
  /** Export permission — runs AFTER the endpoint's `authorize`. If not given, only `authorize` applies. */
  authorize?: (ctx: Ctx) => boolean | Promise<boolean>;
  /**
   * Formats that are produced. `"excel"` needs `exceljs` and `"pdf"` needs
   * `pdfkit` (optional peers; a boot error if not installed). `"pdf"` also
   * needs `pdf.font`.
   *
   * @default ["csv"]
   */
  formats?: DataTableServerExportFormat[];
  /**
   * Row ceiling of a single export: a number applies to all formats, an object
   * applies per format. Because of the Excel sheet limit, `excel` can be at
   * most 1,048,575. A request that exceeds it gets a 413 before streaming
   * starts.
   *
   * @default 100000 for every format
   */
  maxRows?: number | Partial<Record<DataTableServerExportFormat, number>>;
  /**
   * Number of primary keys in a single request in the `selected` scope. A larger value may also require raising Fastify's `bodyLimit`.
   *
   * @default 10000
   */
  maxSelectedKeys?: number;
  /**
   * PDF settings. The built-in PDF fonts do not include Turkish characters (for
   * example the dotless i and the s-cedilla); that is why a font file (TTF/OTF/WOFF, a
   * path or its contents) is required.
   */
  pdf?: { font: { regular: string | Uint8Array; bold?: string | Uint8Array } };
  /**
   * Number of exports streaming at the same time — per process and endpoint
   * (this `datatableRoute`). While it is full, ticket and download requests
   * get a 429.
   *
   * @default 4
   */
  maxConcurrent?: number;
  /**
   * Ticket store (see `handler.exportTicket`). The default is in-process
   * memory (`createMemoryTicketStore()`, at most 1,000 pending tickets); with
   * more than one server instance, provide a shared store. Ticket issuance is
   * NOT limited per user: a per-user/session rate limit is the job of the API
   * gateway.
   *
   * @default createMemoryTicketStore()
   * @experimental May change in any release while the package is in 0.x.
   */
  ticketStore?: import("./ticket.js").DataTableExportTicketStore;
  /**
   * Lifetime of a ticket (ms).
   *
   * @default 60000
   */
  ticketTtlMs?: number;
  /**
   * Number of rows read from the cursor at a time.
   *
   * @default 1000
   */
  batchSize?: number;
  /** Server-side cell formatting (for example an enum label). If not given, the raw value is written. */
  formatter?: (field: string, value: unknown, row: Record<string, unknown>, ctx: Ctx) => unknown;
  /**
   * Audit hook — called ONCE when the export completes, is cancelled, or fails.
   * If it throws, the error is logged and the response is not affected.
   *
   * CAUTION: the event carries `ctx` and the APPLIED QUERY. The query may
   * contain the VALUE searched on a `sensitive` field (for example a queried
   * national ID number); the audit record itself may hold sensitive data. When
   * writing to a persistent record, mask the filter values or store only the
   * field/operator.
   *
   * @experimental May change in any release while the package is in 0.x.
   */
  onExport?: (event: DataTableExportEvent<Ctx>) => void | Promise<void>;
  /** If given, `SET LOCAL statement_timeout` (ms) is applied in the export transaction. */
  statementTimeoutMs?: number;
  /**
   * If the consumer reads nothing for this many ms (a stalled client, or one
   * reading a few bytes per second), the export is cut off: the transaction is
   * rolled back, and the pool connection and the `maxConcurrent` slot are
   * released. Backpressure protects memory but would tie the transaction and
   * the REPEATABLE READ snapshot (which blocks VACUUM) to the client's speed.
   * It ends with `ExportTimeoutError` (`kind: "stalled"`) and `onExport`
   * reports `failed`.
   *
   * @default 60000
   */
  idleTimeoutMs?: number;
  /**
   * Total duration of the export (ms); it is cut off when exceeded
   * (`kind: "duration"`). `Infinity` disables the limit; a finite value can be
   * at most 2,147,483,647. The duration starts when the download request begins
   * to be processed and also covers the opening (COUNT, the first cursor read);
   * during the opening, `SET LOCAL statement_timeout` is set to the remaining
   * time (or to `statementTimeoutMs` if given, whichever is smaller). The limit
   * bounds the lifetime of the REPEATABLE READ snapshot that stays open (VACUUM,
   * migration lock); if you raise `maxRows`, raise this too (a 1.5 GB CSV takes
   * about 10 minutes to download at 20 Mbps).
   *
   * @default 600000 (10 minutes)
   */
  maxDurationMs?: number;
}

/**
 * The event passed to `DataTableExportConfig.onExport` when an export
 * completes, is cancelled, or fails.
 */
export interface DataTableExportEvent<Ctx extends BaseCtx = BaseCtx> {
  /** The context of the user who requested the export. */
  ctx: Ctx;
  /** The export format. */
  format: DataTableServerExportFormat;
  /** The export scope. */
  scope: import("@datatablex/core").DataTableServerExportScope;
  /** The validated query that was applied. In `selected`, `filters` is the primary key `in` filter; `currentPage` carries `pagination`. */
  query: Pick<import("@datatablex/core").DataTableQuery, "filters" | "search" | "sorting"> & { pagination?: import("@datatablex/core").DataTableQuery["pagination"] };
  /** The fields written to the file, in order. */
  fields: string[];
  /** Number of rows written to the response. */
  rowCount: number;
  /** The total in the snapshot — equal to `rowCount` when `completed`. */
  total: number;
  /** How the export ended. */
  outcome: "completed" | "cancelled" | "failed";
  /** Duration of the export in milliseconds. */
  durationMs: number;
  /** The error that ended the export; present when `outcome` is `failed`. */
  error?: unknown;
}

/**
 * The handler returned by `datatableRoute`: callable as the query route
 * itself, with companion handlers attached as members. Registering each of
 * them on a route is up to the consumer.
 *
 * @example
 * ```ts
 * const handler = datatableRoute(db, config);
 * app.post("/api/orders/query", handler);
 * app.get("/api/orders/query/meta", handler.meta);
 * ```
 */
export interface DataTableRouteHandler {
  (req: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  /**
   * The `GET` handler that returns the endpoint's meta description
   * (`describeDataTableEndpoint`) — it goes through the same
   * `getContext`/`authorize` as the query handler. Registering it is up to the
   * consumer, for example `app.get("/api/x/query/meta", handler.meta)`.
   */
  meta: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /**
   * The `GET` handler that returns the filter options of a field
   * (`FieldConfig.options`) — the same `getContext`/`authorize` gate as the
   * query. The field name is read from the `:field` path parameter; registering
   * it is up to the consumer:
   * `app.get("/api/x/query/options/:field", handler.options)`. The response is
   * `{ version: 1, options }` with `cache-control: no-store`. An unknown field,
   * a field that defines no options, or a sensitive field gets
   * `400 field_not_allowed`.
   *
   * @experimental May change in any release while the package is in 0.x.
   */
  options: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /**
   * The ticket `POST` handler (see `DataTableEndpointConfig.export`): the same
   * `getContext`/`authorize` gate, then `export.authorize`; validation, COUNT
   * and the format's `maxRows` (413), concurrency (429). It returns a
   * single-use, short-lived ticket: `{ ticket, total, filename, expiresAt }`.
   * Registering it is up to the consumer; the client derives the download
   * address from the export address, so the two routes are registered side by
   * side:
   * `app.post("/api/x/query/export/ticket", handler.exportTicket)`,
   * `app.get("/api/x/query/export/download", handler.exportDownload)`.
   */
  exportTicket: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /**
   * The `GET` handler of the native download (`?ticket=`). Because the
   * browser's own download cannot carry headers, `getContext` is not called:
   * `ctx` comes from the ticket, the request is validated again with this
   * route's config, and the authorization gates run again. Error responses are
   * `attachment`s too; the browser does not leave the application to open an
   * error page, the download simply appears to fail.
   */
  exportDownload: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}
