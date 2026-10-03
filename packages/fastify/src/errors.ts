/**
 * The `catch` block of `datatableRoute` explicitly maps only `z.ZodError` to
 * 400; every other error is rethrown. That is why EVERY user-error class this
 * package throws must carry a `statusCode` — Fastify turns the `statusCode` of
 * a thrown error into the response code automatically; without it the default
 * error handler returns 500. The same classes also carry a machine-readable
 * `code` (`DataTableErrorCode`): Fastify writes the `code` into the default
 * error body, and the client translates it into its own language.
 *
 * This one is thrown when a query uses a field or an operator that the
 * endpoint config does not allow.
 */
export class FieldNotAllowedError extends Error {
  /** HTTP status of the response. */
  readonly statusCode = 400;
  /** Machine-readable error code. */
  readonly code = "field_not_allowed" as const;
  constructor(field: string) {
    super(`Field or operator not allowed: ${field}`);
    this.name = "FieldNotAllowedError";
  }
}

/** A filter value does not match the wire shape of its field's type, or `parseValue` rejected it. */
export class InvalidFilterValueError extends Error {
  readonly statusCode = 400;
  readonly code = "invalid_filter_value" as const;
  constructor(field: string, cause: unknown) {
    super(`Invalid filter value for field: ${field}`);
    this.name = "InvalidFilterValueError";
    this.cause = cause;
  }
}

/** The query has a `search` but the endpoint has no `searchable` fields. */
export class SearchNotSupportedError extends Error {
  readonly statusCode = 400;
  readonly code = "search_not_supported" as const;
  constructor() {
    super("This endpoint has no searchable fields");
    this.name = "SearchNotSupportedError";
  }
}

/**
 * The client speaks a wire protocol version that this server does not support
 * (see `x-datatablex-protocol`). Returns 400; the response carries the
 * supported versions in the `supported` field. A request without the header is
 * treated as version 1.
 */
export class UnsupportedProtocolError extends Error {
  readonly statusCode = 400;
  readonly code = "unsupported_protocol" as const;
  /** The protocol versions this server supports. */
  readonly supported: readonly number[];
  constructor(received: string, supported: readonly number[]) {
    super(`DataTableX protocol version is not supported: client "${received}", server [${supported.join(", ")}]. Upgrade the client and server packages to the same protocol version.`);
    this.name = "UnsupportedProtocolError";
    this.supported = supported;
  }
}

/** The number of rows in the export exceeds `export.maxRows` — rejected before streaming starts. */
export class ExportTooLargeError extends Error {
  readonly statusCode = 413;
  readonly code = "export_too_large" as const;
  /** Number of rows the export would contain. */
  readonly total: number;
  /** The row ceiling that applies to the requested format. */
  readonly maxRows: number;
  constructor(total: number, maxRows: number) {
    super(`The export contains ${total} rows; this endpoint exports at most ${maxRows} rows. Narrow the filters.`);
    this.name = "ExportTooLargeError";
    this.total = total;
    this.maxRows = maxRows;
  }
}

/**
 * A deployment error (500): the export uses Kysely `.stream()` to stream rows,
 * and on PostgreSQL this requires `PostgresDialect` to be set up with the
 * `cursor` option (the `pg-cursor` package).
 */
export class ExportStreamingUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "The server export could not stream rows: pass `cursor` to Kysely's `PostgresDialect` " +
        "(`import Cursor from \"pg-cursor\"`; `new PostgresDialect({ pool, cursor: Cursor })`).",
    );
    this.name = "ExportStreamingUnavailableError";
    this.cause = cause;
  }
}

/**
 * NOT the client's fault — the integrator's `scope` function did not return a
 * boolean expression (see `DataTableEndpointConfig.scope`). The type already
 * forbids this; the check is for JS consumers or `as` casts. It deliberately
 * does NOT carry a `statusCode`: the deployment is responsible, not the
 * client; `datatableRoute` wraps it in a `DataTableInternalError` (500,
 * `internal_error`), and its message goes to the server log, not to the
 * client. When the scope cannot be applied, the query is never run
 * (fail-closed).
 */
export class InvalidScopeError extends Error {
  constructor(received: string) {
    super(
      `\`scope\` must return a boolean expression (Expression<SqlBool>), received: ${received}. ` +
        "Use `eb.lit(true)` for an unrestricted role; use `eb.exists(eb.selectFrom(...))` for authorization through another table.",
    );
    this.name = "InvalidScopeError";
  }
}

/**
 * An unexpected error that carries no `statusCode`: a deployment error
 * (`InvalidScopeError`), a database error (connection, `statement_timeout`,
 * missing table ...), or a plain `Error` thrown by `getContext`/`authorize`.
 * `datatableRoute` turns these into a 500 that leaks no detail to the client:
 * the body is `{ statusCode: 500, code: "internal_error", error: "Internal
 * Server Error", message }` and `message` is constant. The original error is in
 * `cause`; Fastify's error log (the pino `err` serializer also writes `cause`)
 * or the application's `setErrorHandler` sees it. Errors that carry a
 * `statusCode` (this package's 4xx errors, the 401 from `getContext` ...) are
 * not wrapped.
 */
export class DataTableInternalError extends Error {
  /** HTTP status of the response. */
  readonly statusCode = 500;
  /** Machine-readable error code. */
  readonly code = "internal_error" as const;
  constructor(cause: unknown) {
    super("The server could not process the request.");
    this.name = "DataTableInternalError";
    this.cause = cause;
  }
}

/**
 * The `FieldConfig.options` resolver returned a list longer than
 * `maxOptions`. It is a deployment error, but it carries its own code so that
 * the client can tell the cause apart; `message` is constant, and the field and
 * the numbers go only to the server log.
 */
export class OptionsTooLargeError extends Error {
  /** HTTP status of the response. */
  readonly statusCode = 500;
  /** Machine-readable error code. */
  readonly code = "options_too_large" as const;
  /** The field whose resolver returned too many options. */
  readonly field: string;
  /** Number of options the resolver returned. */
  readonly count: number;
  /** The ceiling that applied to the field. */
  readonly maxOptions: number;
  constructor(field: string, count: number, maxOptions: number) {
    super("The option list exceeds the server limit.");
    this.name = "OptionsTooLargeError";
    this.field = field;
    this.count = count;
    this.maxOptions = maxOptions;
  }
}

/** An error that carries a `statusCode` is returned as it is; one that does not is wrapped in a `DataTableInternalError`. */
export function toPublicError(err: unknown): unknown {
  return typeof (err as { statusCode?: unknown } | null)?.statusCode === "number" ? err : new DataTableInternalError(err);
}

/**
 * The export stream hit a time limit and was cut off: `kind: "stalled"` — the
 * consumer read nothing for `export.idleTimeoutMs`; `"duration"` — the total
 * time exceeded `export.maxDurationMs`. If it happens during streaming, it does
 * not reach the client as a status code (the download is cut off midway); if
 * `"duration"` happens during the opening (COUNT, the first cursor read), the
 * download route returns 500 `export_failed`. In both cases the transaction is
 * rolled back and the `onExport` event is called once with `failed` and this
 * error.
 */
export class ExportTimeoutError extends Error {
  /** Which limit was hit: `"stalled"` (idle) or `"duration"` (total time). */
  readonly kind: "stalled" | "duration";
  /** The limit that was exceeded, in milliseconds. */
  readonly limitMs: number;
  constructor(kind: "stalled" | "duration", limitMs: number) {
    super(
      kind === "stalled"
        ? `The export stream was not read for ${limitMs} ms; the transaction and the connection were released (export.idleTimeoutMs).`
        : `The export exceeded the ${limitMs} ms time limit and was cut off (export.maxDurationMs).`,
    );
    this.name = "ExportTimeoutError";
    this.kind = kind;
    this.limitMs = limitMs;
  }
}

/**
 * The ticket store is full (`createMemoryTicketStore({ maxTickets })`): no new
 * ticket is issued, and 429 is returned. A custom store gets the same response
 * by throwing this same class.
 */
export class ExportTicketStoreFullError extends Error {
  /** HTTP status of the response. */
  readonly statusCode = 429;
  /** Machine-readable error code. */
  readonly code = "export_busy" as const;
  /** The pending-ticket ceiling that was reached. */
  readonly maxTickets: number;
  constructor(maxTickets: number) {
    super(`The number of pending export tickets reached the limit (${maxTickets}); try again shortly.`);
    this.name = "ExportTicketStoreFullError";
    this.maxTickets = maxTickets;
  }
}