import { Readable } from "node:stream";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { z } from "zod";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { DataTableQuery, DataTableServerExportFormat, DataTableServerExportScope } from "@datatablex/core";
import type { BaseCtx, DataTableEndpointConfig, DataTableExportEvent } from "./types.js";
import { assertValidEndpointConfig } from "./config.js";
import { EXPECTED_BY_TYPE, validateDataTableQuery, valueSchemaFor } from "./validate.js";
import { buildDataTableQuery } from "./handler.js";
import { resolveLimits } from "./limits.js";
import { resolveExportConfig } from "./projection.js";
import { ExportStreamingUnavailableError, ExportTimeoutError, ExportTooLargeError } from "./errors.js";
import { EXPORT_CONTENT_TYPE, EXPORT_EXTENSION, createExportWriter } from "./exportWriters/index.js";
import type { ExportWriter } from "./exportWriters/index.js";

/** A validated export request. `query` is the query with the scope already applied (see `DataTableExportEvent.query`). */
export interface ValidatedExportRequest {
  /** The requested export format. */
  format: DataTableServerExportFormat;
  /** Which rows the export covers. */
  scope: DataTableServerExportScope;
  /** The query with the scope applied. */
  query: DataTableExportEvent["query"];
  /** The columns to export, in order, with the header title of each. */
  columns: Array<{ field: string; title: string }>;
  /** The sanitized file name, always ending with the format's extension. */
  filename: string;
  /** The document title: the requested title, or the file name without its extension. */
  title: string;
}

const MAX_TITLE_LENGTH = 200;
const MAX_FILENAME_LENGTH = 200;
/** If the consumer has not read, the producer re-checks the buffer after this long (guards against a missed notification). */
const PULL_POLL_MS = 50;
/**
 * Writing XLSX/PDF rows is CPU-bound and synchronous; if a cursor batch (1000
 * rows) were processed without releasing the event loop, the server could not
 * answer other requests for that long. The budget is time, not row count: in PDF,
 * 256 rows take hundreds of milliseconds. The producer yields to the event loop
 * after running this long.
 */
const YIELD_AFTER_MS = 20;

const exportRequestSchema = z.object({
  query: z.object({}).passthrough(),
  format: z.enum(["csv", "excel", "pdf"]),
  scope: z.enum(["allFiltered", "currentPage", "selected"]).default("allFiltered"),
  keys: z.array(z.union([z.string(), z.number()])).optional(),
  columns: z
    .array(z.object({ field: z.string(), title: z.string().max(MAX_TITLE_LENGTH) }))
    .min(1),
  filename: z.string().max(MAX_FILENAME_LENGTH).optional(),
  title: z.string().max(MAX_TITLE_LENGTH).optional(),
});

/**
 * Replaces lone surrogate code units with U+FFFD. `encodeURIComponent` throws a
 * `URIError` on them; if the header were built after the export transaction was
 * opened, the throw would leak the transaction and the `maxConcurrent` slot.
 * (A hand-written equivalent of `String.prototype.toWellFormed`.)
 */
function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/**
 * The file name is only a display name, but it goes into `Content-Disposition`:
 * lone surrogates, control characters, path separators and quotes are removed or
 * replaced, and the format's extension is enforced.
 */
function sanitizeFilename(raw: string | undefined, format: DataTableServerExportFormat): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = wellFormed(raw ?? "").replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "").trim();
  const base = cleaned || "export";
  const extension = `.${EXPORT_EXTENSION[format]}`;
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

/** Builds a `Content-Disposition` value per RFC 6266/5987: an ASCII fallback name plus a UTF-8 `filename*`. */
export function contentDisposition(filename: string): string {
  const safe = wellFormed(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Validates an export request. The query goes through the SAME rules as
 * `/query` (`validateDataTableQuery`); the columns must be in the endpoint's
 * export allowlist and the format must be in the endpoint's `formats`.
 * Depending on the scope:
 * - `allFiltered`: pagination is ignored.
 * - `currentPage`: `query.pagination` is required; it is clamped to
 *   `maxPageSize`, as in `/query`.
 * - `selected`: `keys` is required (at most `maxSelectedKeys`, of the primary
 *   key's type). The client's filters and search are ignored; the query is the
 *   `scope` plus an `in` filter on the primary key, and sorting is kept.
 *
 * @throws {z.ZodError} For an invalid request; query paths are prefixed with `query.`.
 * @throws {Error} When export is disabled on the endpoint or the config is invalid.
 */
export function validateDataTableExportRequest<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  body: unknown,
  config: DataTableEndpointConfig<DB, TB, Ctx>,
): ValidatedExportRequest {
  assertValidEndpointConfig(config);
  const exportConfig = resolveExportConfig(config);
  if (!exportConfig) throw new Error("[datatablex] Export is disabled on this endpoint (`export` was not provided).");

  const parsed = exportRequestSchema.parse(body);
  const issues: z.ZodIssue[] = [];
  if (!exportConfig.formats.includes(parsed.format)) {
    issues.push({ code: z.ZodIssueCode.custom, path: ["format"], message: `Format "${parsed.format}" is not enabled on this endpoint (enabled: ${exportConfig.formats.join(", ")})` });
  }
  const allowed = new Set(exportConfig.fields);
  parsed.columns.forEach((column, index) => {
    if (!allowed.has(column.field)) {
      issues.push({ code: z.ZodIssueCode.custom, path: ["columns", index, "field"], message: `Field "${column.field}" is not enabled for export on this endpoint` });
    }
  });

  const raw = parsed.query as Record<string, unknown>;
  let pagination: DataTableQuery["pagination"] | undefined;
  let queryBody: Record<string, unknown>;
  if (parsed.scope === "selected") {
    queryBody = { sorting: raw.sorting ?? [], filters: null, pagination: { page: 1, pageSize: 1 } };
  } else if (parsed.scope === "currentPage") {
    if (raw.pagination === undefined) issues.push({ code: z.ZodIssueCode.custom, path: ["query", "pagination"], message: "The currentPage scope requires query.pagination" });
    queryBody = { ...raw, skipCount: undefined };
  } else {
    queryBody = { ...raw, pagination: { page: 1, pageSize: 1 }, skipCount: undefined };
  }
  if (parsed.scope !== "selected" && parsed.keys !== undefined) {
    issues.push({ code: z.ZodIssueCode.custom, path: ["keys"], message: "keys can only be sent with the selected scope" });
  }

  let query: DataTableQuery;
  try {
    query = validateDataTableQuery(queryBody, config);
  } catch (err) {
    // Format and column problems are returned together with the query's, in a single 400.
    if (err instanceof z.ZodError) throw new z.ZodError([...issues, ...err.issues.map((issue) => ({ ...issue, path: ["query", ...issue.path] }))]);
    throw err;
  }
  if (parsed.scope === "currentPage" && raw.pagination !== undefined) {
    pagination = { page: query.pagination.page, pageSize: Math.min(query.pagination.pageSize, resolveLimits(config).maxPageSize) };
  }

  let filters = query.filters;
  let search = query.search;
  if (parsed.scope === "selected") {
    const primaryKey = config.fields[config.primaryKey]!;
    const keys = parsed.keys ?? [];
    if (!keys.length) issues.push({ code: z.ZodIssueCode.custom, path: ["keys"], message: "The selected scope requires at least one value in keys" });
    if (keys.length > exportConfig.maxSelectedKeys) {
      issues.push({ code: z.ZodIssueCode.too_big, maximum: exportConfig.maxSelectedKeys, type: "array", inclusive: true, path: ["keys"], message: `keys can hold at most ${exportConfig.maxSelectedKeys} items` });
    }
    const schema = valueSchemaFor(primaryKey.type);
    keys.forEach((key, index) => {
      if (!schema.safeParse(key).success) {
        issues.push({ code: z.ZodIssueCode.custom, path: ["keys", index], message: `primary key "${config.primaryKey}" has type: "${primaryKey.type}" — expected ${EXPECTED_BY_TYPE[primaryKey.type]}` });
      }
    });
    filters = { operator: "AND", filters: [{ field: config.primaryKey, operator: "in", value: Array.from(new Set(keys)) }] };
    search = undefined;
  }
  if (issues.length) throw new z.ZodError(issues);

  const filename = sanitizeFilename(parsed.filename, parsed.format);
  return {
    format: parsed.format,
    scope: parsed.scope,
    query: { filters, search, sorting: query.sorting, ...(pagination ? { pagination } : null) },
    columns: parsed.columns,
    filename,
    title: parsed.title?.trim() || filename.slice(0, filename.lastIndexOf(".")),
  };
}

/**
 * Number of rows in the export; for `currentPage`, the rows on that page. It is
 * used when the ticket is issued (without a snapshot, for an early 413) and
 * inside the export transaction.
 */
export async function countDataTableExport<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  db: Kysely<DB>,
  config: DataTableEndpointConfig<DB, TB, Ctx>,
  request: ValidatedExportRequest,
  ctx: Ctx,
): Promise<number> {
  const { filtered } = buildDataTableQuery(db, config, request.query, ctx);
  const countRow = await filtered.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirstOrThrow();
  const total = Number((countRow as { total: string }).total);
  const page = request.query.pagination;
  return page ? Math.max(0, Math.min(page.pageSize, total - (page.page - 1) * page.pageSize)) : total;
}

/** An export that has been opened and is ready to stream. */
export interface OpenedExport {
  /** Number of rows in the export snapshot; the stream writes this many rows. */
  total: number;
  /** The sanitized file name for the response. */
  filename: string;
  /** The response `Content-Type`. */
  contentType: string;
  /** File body. If it is destroyed (the client disconnected), the cursor is closed and the transaction is rolled back. */
  body: Readable;
}

/**
 * Opens the export: starts a REPEATABLE READ, read-only transaction, runs COUNT
 * on the same snapshot (`ExportTooLargeError` if the format's `maxRows` is
 * exceeded), opens the ordered query with a cursor, reads the first batch AHEAD
 * of time and creates the format's writer. This way setup errors (a dialect
 * without cursor support, an SQL error, a broken font) surface as a proper error
 * response before any response header is sent.
 *
 * The returned `body` passes the rows through the writer. While the writer's
 * buffer is full (`congested`), no new rows are read from the database, so
 * server memory does not depend on the row count or on the client's speed. When
 * the stream ends, is destroyed or fails, the transaction is closed and
 * `onExport` is called ONCE.
 *
 * @throws {ExportTooLargeError} When the row count exceeds the format's `maxRows`.
 * @throws {ExportTimeoutError} When opening takes longer than `maxDurationMs`.
 * @throws {ExportStreamingUnavailableError} When the database driver cannot open a cursor.
 * @throws {Error} When export is disabled, the config is invalid, or the query or writer setup fails.
 */
export async function openDataTableExport<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  db: Kysely<DB>,
  config: DataTableEndpointConfig<DB, TB, Ctx>,
  request: ValidatedExportRequest,
  ctx: Ctx,
  options: { onHookError?: (err: unknown) => void } = {},
): Promise<OpenedExport> {
  assertValidEndpointConfig(config);
  const exportConfig = resolveExportConfig(config);
  if (!exportConfig) throw new Error("[datatablex] Export is disabled on this endpoint (`export` was not provided).");
  const { fields } = config;
  const startedAt = Date.now();
  const selectKeys = Array.from(new Set(request.columns.map((c) => c.field)));
  const maxRows = exportConfig.maxRows[request.format]!;

  let rowCount = 0;
  let total = 0;
  let finished = false;
  const emit = async (outcome: DataTableExportEvent<Ctx>["outcome"], error?: unknown) => {
    const event: DataTableExportEvent<Ctx> = {
      ctx,
      format: request.format,
      scope: request.scope,
      query: request.query,
      fields: request.columns.map((c) => c.field),
      rowCount,
      total,
      outcome,
      durationMs: Date.now() - startedAt,
      ...(error !== undefined ? { error } : null),
    };
    try {
      await config.export?.onExport?.(event);
    } catch (hookError) {
      options.onHookError?.(hookError);
    }
  };

  // `maxDurationMs` is the TOTAL duration of the export (the same clock as `durationMs` in the
  // event): opening (COUNT, the first cursor read) counts against it too. If the timer were
  // started when streaming begins, a slow COUNT would hold the transaction, the connection and
  // the `maxConcurrent` slot far beyond the limit. `Infinity` turns the limit off.
  // The default is applied in `resolveExportConfig`.
  const maxDurationMs = exportConfig.maxDurationMs;
  const deadline = Number.isFinite(maxDurationMs) ? startedAt + maxDurationMs : undefined;
  const durationExceeded = () => new ExportTimeoutError("duration", maxDurationMs);
  /**
   * Races an opening step against the remaining time; if time runs out it rejects with
   * `ExportTimeoutError("duration")`. The race only cuts the wait: the query in the database
   * is stopped by `statement_timeout` (set below from the remaining time), and the rollback
   * follows after that.
   */
  const beforeDeadline = <R>(step: Promise<R>): Promise<R> => {
    if (deadline === undefined) return step;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(durationExceeded()), Math.max(0, deadline - Date.now()));
    });
    return Promise.race([step, expired]).finally(() => clearTimeout(timer));
  };

  // Single snapshot: COUNT and the stream run in the same transaction, under REPEATABLE READ.
  // Opening is not raced: a transaction that opens after a lost race would be left orphaned.
  const trx = await db.startTransaction().setIsolationLevel("repeatable read").setAccessMode("read only").execute();
  const rollback = () => trx.rollback().execute().catch(() => {});

  let iterator: AsyncIterator<Record<string, unknown>>;
  let first: IteratorResult<Record<string, unknown>>;
  let writer: ExportWriter;
  try {
    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) throw durationExceeded();
    // The remaining time is also the limit in the database: a COUNT that loses the race does not keep running on the server.
    const statementTimeoutMs =
      remainingMs === undefined ? exportConfig.statementTimeoutMs : Math.min(exportConfig.statementTimeoutMs ?? Infinity, Math.ceil(remainingMs));
    if (statementTimeoutMs !== undefined) {
      // Validated at boot to be a positive safe integer; SET does not accept parameters.
      await sql.raw(`set local statement_timeout = ${statementTimeoutMs}`).execute(trx);
    }
    total = await beforeDeadline(countDataTableExport(trx, config, request, ctx));
    if (total > maxRows) throw new ExportTooLargeError(total, maxRows);
    const { ordered } = buildDataTableQuery(trx, config, request.query, ctx);
    const page = request.query.pagination;

    let rows = ordered.select((eb) => selectKeys.map((key) => eb.ref(fields[key]!.column).as(key)));
    if (page) rows = rows.limit(page.pageSize).offset((page.page - 1) * page.pageSize);
    const stream = rows.stream(exportConfig.batchSize) as AsyncIterable<Record<string, unknown>>;
    iterator = stream[Symbol.asyncIterator]();
    try {
      first = await beforeDeadline(iterator.next());
    } catch (err) {
      // If time ran out, the cursor read may still be in progress: `return` waits for it to finish and then closes the cursor.
      await iterator.return?.().catch(() => {});
      if (err instanceof Error && /cursor/i.test(err.message)) throw new ExportStreamingUnavailableError(err);
      throw err;
    }
    try {
      writer = await createExportWriter(
        request.format,
        request.columns.map((c) => ({ ...c, type: fields[c.field]!.type })),
        { title: request.title, pdfFont: config.export?.pdf?.font },
      );
    } catch (err) {
      await iterator.return?.().catch(() => {});
      throw err;
    }
  } catch (err) {
    await rollback();
    if (!(err instanceof ExportTooLargeError)) await emit("failed", err);
    throw err;
  }

  const formatter = config.export?.formatter;
  const toValues = (row: Record<string, unknown>) => request.columns.map((c) => (formatter ? formatter(c.field, row[c.field], row, ctx) : row[c.field]));

  let started = false;
  let completed = false;
  let stopped = false;
  let failure: unknown;
  let durationTimer: NodeJS.Timeout | undefined;
  const finish = async () => {
    if (finished) return;
    finished = true;
    clearTimeout(durationTimer);
    if (!completed) {
      writer.abort();
      await iterator.return?.().catch(() => {});
    }
    if (completed) await trx.commit().execute().catch(() => {});
    else await rollback();
    await emit(completed ? "completed" : failure !== undefined ? "failed" : "cancelled", failure);
  };

  // Producer: writes rows to the writer and, if the buffer is full, waits for the consumer to read.
  let notifyPull: (() => void) | null = null;
  const waitForPull = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PULL_POLL_MS);
      notifyPull = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  // The last time the consumer read (used by the watchdog below).
  let lastPullAt = Date.now();
  // All rows have been handed to the writer; what remains is for the consumer to drain the buffer.
  let produced = false;
  const pulled = () => {
    lastPullAt = Date.now();
    const notify = notifyPull;
    notifyPull = null;
    notify?.();
  };
  const produce = async () => {
    let sliceStarted = performance.now();
    for (let next = first; !next.done; next = await iterator.next()) {
      if (stopped) return;
      writer.writeRow(toValues(next.value));
      rowCount++;
      if (performance.now() - sliceStarted >= YIELD_AFTER_MS) {
        await yieldToEventLoop();
        sliceStarted = performance.now();
      }
      while (!stopped && writer.congested()) await waitForPull();
    }
    if (!stopped) await writer.end();
    produced = true;
  };

  // When the stream is destroyed from outside (the client disconnected), Node throws the error
  // into the `yield` the generator is WAITING at: this is a cancellation, not a failure.
  // An error from the database, the formatter or the writer counts as `failed`.
  let yielding = false;
  async function* chunks(): AsyncGenerator<Buffer | string> {
    started = true;
    const producing = produce().catch((err: unknown) => {
      failure = err;
      writer.abort(err);
    });
    try {
      for await (const chunk of writer.out) {
        yielding = true;
        yield chunk as Buffer | string;
        yielding = false;
        pulled();
      }
      await producing;
      if (failure !== undefined) throw failure;
      completed = true;
    } catch (err) {
      if (!yielding && failure === undefined) failure = err;
      throw err;
    } finally {
      stopped = true;
      pulled();
      await producing;
      await finish();
    }
  }

  // In byte mode: the 16-chunk buffer of object mode (each chunk up to 64 KB) would let the producer run ahead unnecessarily.
  const body = Readable.from(chunks(), { objectMode: false });
  // Time limits. Backpressure protects memory, but it ties the transaction and the REPEATABLE READ
  // snapshot (which blocks VACUUM) to the client's speed; so a client that does not read, and the
  // total duration, are limited separately. Both are cut the same way: the writer and the body are
  // destroyed with the error, `finish` rolls the transaction back, and the event becomes `failed`.
  const cut = (error: ExportTimeoutError) => {
    if (finished) return;
    failure ??= error;
    stopped = true;
    pulled();
    // If the body was never read, neither the writer output nor the body has an error listener:
    // destroying them with an error would raise an unhandled 'error' event. `close` still runs
    // `finish` (below).
    writer.abort(started ? error : undefined);
    body.destroy(started ? error : undefined);
  };
  if (deadline !== undefined) {
    // Remaining time: the time already spent opening is deducted.
    durationTimer = setTimeout(() => cut(durationExceeded()), Math.max(0, deadline - Date.now()));
    durationTimer.unref();
  }
  {
    // Watchdog: cut if the consumer has not read for `idleTimeoutMs` AND the side being waited on
    // is the consumer (the body was never read, the producer has filled the buffer and is waiting,
    // or production is finished and the buffer is waiting to be drained). If the producer is
    // waiting on the DATABASE, the consumer is not to blame (that is what `statementTimeoutMs`
    // is for).
    const idleMs = exportConfig.idleTimeoutMs;
    const watchdog = setInterval(
      () => {
        if (finished) return;
        const consumerIsBlocking = !started || produced || writer.congested();
        if (consumerIsBlocking && Date.now() - lastPullAt >= idleMs) cut(new ExportTimeoutError("stalled", idleMs));
      },
      Math.min(1000, Math.max(10, Math.floor(idleMs / 3))),
    );
    watchdog.unref();
    body.once("close", () => clearInterval(watchdog));
  }
  // If the body is destroyed without ever being read (the connection dropped before the headers
  // were sent), the generator never starts and its `finally` never runs, so the transaction is
  // closed here.
  body.once("close", () => {
    if (!started) void finish();
  });
  return { total, filename: request.filename, contentType: EXPORT_CONTENT_TYPE[request.format], body };
}
