import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { DATATABLEX_TOTAL_HEADER } from "@datatablex/core";
import type { DataTableFieldOptions, DataTableQuery } from "@datatablex/core";
import type { BaseCtx, DataTableEndpointConfig, DataTableRouteHandler } from "./types.js";
import { handleDataTableQuery } from "./handler.js";
import { validateDataTableQuery } from "./validate.js";
import { describeDataTableEndpoint } from "./describe.js";
import { assertValidEndpointConfig, optionsShapeProblem } from "./config.js";
import { DEFAULT_MAX_OPTIONS } from "./types.js";
import { assertSupportedProtocol } from "./protocol.js";
import { DataTableInternalError, ExportTicketStoreFullError, ExportTooLargeError, FieldNotAllowedError, OptionsTooLargeError, UnsupportedProtocolError, toPublicError } from "./errors.js";
import { contentDisposition, countDataTableExport, openDataTableExport, validateDataTableExportRequest } from "./export.js";
import { resolveExportConfig } from "./projection.js";
import { TICKET_ID_PATTERN, createMemoryTicketStore, createTicketId } from "./ticket.js";
import { loadExcelJS, loadPdfKit } from "./exportWriters/packages.js";
import type { ValidatedExportRequest } from "./export.js";

/** `details` already carries all the issues; `message` reduces the first issue to one readable line. */
function formatZodMessage(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return "Validation Error";
  const path = first.path.join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

/**
 * Creates the Fastify handler of a data table endpoint. The handler validates
 * the request body, applies the field allowlist, runs the query through Kysely
 * and returns a `DataTableResult`. The config is validated once, when this
 * function is called; the same `getContext` and `authorize` gate guards the
 * query and every handler attached to the returned function (`meta`,
 * `options`, `exportTicket`; `exportDownload` takes its `ctx` from the ticket).
 *
 * The returned function is the query handler. `meta`, `options`,
 * `exportTicket` and `exportDownload` are properties of it; registering them
 * is the consumer's job (see `DataTableRouteHandler`). Without `config.export`,
 * `exportTicket` and `exportDownload` answer 404.
 *
 * @example
 * ```ts
 * import Fastify from "fastify";
 * import { datatableRoute } from "@datatablex/fastify";
 *
 * const app = Fastify();
 *
 * const accessLogs = datatableRoute(db, {
 *   table: "access_logs",
 *   primaryKey: "id",
 *   fields: {
 *     id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
 *     stadiumName: { column: "stadium_name", type: "text", sortable: true, searchable: true, filterOperators: ["eq", "contains"] },
 *   },
 *   getContext: async (req) => ({ userId: req.user.id, roles: req.user.roles }),
 *   authorize: (ctx) => ctx.roles.includes("viewer"),
 * });
 *
 * app.post("/api/access-logs/query", accessLogs);
 * app.get("/api/access-logs/query/meta", accessLogs.meta);
 * ```
 *
 * @param db - The Kysely instance the queries run on.
 * @param config - The endpoint config: the table, the field allowlist and the authorization hooks.
 * @returns The query handler, with the `meta`, `options`, `exportTicket` and `exportDownload` handlers attached.
 * @throws {Error} When the config is invalid (checked once, at registration time).
 */
export function datatableRoute<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  db: Kysely<DB>,
  config: DataTableEndpointConfig<DB, TB, Ctx>,
): DataTableRouteHandler {
  // Boot-time validation — once when the application starts, not on every request.
  assertValidEndpointConfig(config);

  const meta = describeDataTableEndpoint(config);

  // The protocol version is checked BEFORE authentication: it is cheap and its
  // response (the supported versions) is not secret information.
  const unsupportedProtocol = (req: FastifyRequest, reply: FastifyReply) => {
    try {
      assertSupportedProtocol(req);
      return null;
    } catch (err) {
      if (!(err instanceof UnsupportedProtocolError)) throw err;
      return reply.code(400).send({ error: "Unsupported Protocol", code: err.code, message: err.message, supported: err.supported });
    }
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const rejected = unsupportedProtocol(req, reply);
    if (rejected) return rejected;
    const ctx = await config.getContext(req);
    // Every error body carries `message` — error classes that carry a
    // `statusCode` come out of Fastify's default handler as
    // {statusCode, error, message}, where `error` is the HTTP status text
    // ("Bad Request"), not the error message. If `message` were not a common
    // field, the only field a client could read would be `error`, and this
    // package's own error messages would never reach it.
    if (!(await config.authorize(ctx))) return reply.code(403).send({ error: "Forbidden", code: "forbidden", message: "Forbidden" });

    let query: DataTableQuery;
    try {
      query = validateDataTableQuery(req.body, config);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: "Validation Error", code: "validation", message: formatZodMessage(err), details: err.issues });
      }
      throw err; // errors that carry a statusCode (SearchNotSupportedError etc.) are translated automatically by Fastify
    }

    return handleDataTableQuery(db, config, query, ctx); // FieldNotAllowedError carries a statusCode, so it is not caught separately here
  };

  // Meta exposes the field list, so it goes through the SAME gate as the query;
  // a client that has no permission to query has no need to learn the shape of
  // the endpoint.
  const metaHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const rejected = unsupportedProtocol(req, reply);
    if (rejected) return rejected;
    const ctx = await config.getContext(req);
    if (!(await config.authorize(ctx))) return reply.code(403).send({ error: "Forbidden", code: "forbidden", message: "Forbidden" });
    return meta;
  };

  // Options are user-specific: the resolver is called with `ctx` on every
  // request and the result is NOT cached here (a cache independent of `ctx`
  // would hand one tenant's list to another).
  const optionsHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const rejected = unsupportedProtocol(req, reply);
    if (rejected) return rejected;
    const ctx = await config.getContext(req);
    if (!(await config.authorize(ctx))) return reply.code(403).send({ error: "Forbidden", code: "forbidden", message: "Forbidden" });

    const raw = (req.params as Record<string, unknown> | undefined)?.field;
    const key = typeof raw === "string" ? raw : "";
    // `Object.hasOwn`: prototype keys such as `fields["constructor"]` do not count as fields.
    const field = Object.hasOwn(config.fields, key) ? config.fields[key] : undefined;
    // The boot rule already rejects `options` on a sensitive field; an unknown field and a field without options get the same response.
    if (!field || field.options === undefined) throw new FieldNotAllowedError(key);

    const options = typeof field.options === "function" ? await field.options(ctx) : field.options;
    const problem = optionsShapeProblem(options);
    if (problem) throw new Error(`The options resolver of field "${key}" returned an invalid result: ${problem}`);
    const maxOptions = field.maxOptions ?? DEFAULT_MAX_OPTIONS;
    if (options.length > maxOptions) {
      const err = new OptionsTooLargeError(key, options.length, maxOptions);
      req.log.error({ err, field: key, count: options.length, maxOptions }, "[datatablex] the options list exceeds maxOptions");
      throw err;
    }
    const body: DataTableFieldOptions = { version: 1, options: options.map(({ label, value }) => ({ label, value })) };
    return reply.header("cache-control", "no-store").send(body);
  };

  // --- Server-side export ---
  const exportConfig = resolveExportConfig(config);
  // The libraries of the enabled formats are loaded at startup: the first load
  // blocks the event loop (measured: exceljs ~350 ms, pdfkit ~140 ms); this
  // should happen at startup, not in the middle of a request. The presence of
  // the package was already verified at boot.
  if (exportConfig?.formats.includes("excel")) void loadExcelJS().catch(() => {});
  if (exportConfig?.formats.includes("pdf")) void loadPdfKit().catch(() => {});
  const ticketStore = config.export?.ticketStore ?? createMemoryTicketStore();
  /**
   * Exports that are opening or streaming — `maxConcurrent` applies per process
   * and per endpoint. The slot is reserved BEFORE the transaction is opened
   * (before any `await`, synchronously): if the counter were incremented after
   * `openDataTableExport` returned, every download that arrived while COUNT and
   * the first cursor batch were running (seconds on a large table) would pass
   * the check.
   */
  let activeExports = 0;
  const busy = () => exportConfig !== null && activeExports >= exportConfig.maxConcurrent;
  /** Reserves a slot and returns a `release` function that takes effect only once; returns `null` when full. It must be called without an `await` in between. */
  const reserveExportSlot = () => {
    if (busy()) return null;
    activeExports++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeExports--;
    };
  };
  const busyBody = () => ({ error: "Too Many Exports", code: "export_busy", message: `At most ${exportConfig!.maxConcurrent} exports can run at the same time; try again shortly.`, maxConcurrent: exportConfig!.maxConcurrent });
  const onHookError = (req: FastifyRequest) => (hookError: unknown) => req.log.error({ err: hookError }, "[datatablex] export.onExport threw");

  /** Identity → `authorize` → `export.authorize`. If a gate rejects, it sends the response and returns the sent reply; otherwise it returns `null`. */
  const authorizeExport = async (ctx: Ctx, send: (code: number, body: Record<string, unknown>) => FastifyReply) => {
    if (!(await config.authorize(ctx))) return send(403, { error: "Forbidden", code: "forbidden", message: "Forbidden" });
    if (config.export?.authorize && !(await config.export.authorize(ctx))) return send(403, { error: "Forbidden", code: "export_forbidden", message: "Not authorized to export" });
    return null;
  };
  const sendJson = (reply: FastifyReply) => (code: number, body: Record<string, unknown>) => reply.code(code).send(body);

  const validationError = (err: z.ZodError) => ({ error: "Validation Error", code: "validation", message: formatZodMessage(err), details: err.issues });
  const tooLarge = (err: ExportTooLargeError) => ({ error: "Export Too Large", code: err.code, message: err.message, total: err.total, maxRows: err.maxRows });

  const sendFile = (reply: FastifyReply, opened: Awaited<ReturnType<typeof openDataTableExport>>, disposition: string) =>
    reply
      .header("content-type", opened.contentType)
      .header("content-disposition", disposition)
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header(DATATABLEX_TOTAL_HEADER, String(opened.total))
      // So that they can be read from a different origin (CORS); no effect on the same origin.
      .header("access-control-expose-headers", `${DATATABLEX_TOTAL_HEADER}, content-disposition`)
      .send(opened.body);

  // Ticket: the gates, validation, the early COUNT (413) and concurrency (429) are handled here; the file is produced in the download.
  const exportTicketHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.export) return reply.code(404).send({ error: "Not Found", code: "export_disabled", message: "Server-side export is disabled on this endpoint" });
    const rejected = unsupportedProtocol(req, reply);
    if (rejected) return rejected;
    const ctx = await config.getContext(req);
    const denied = await authorizeExport(ctx, sendJson(reply));
    if (denied) return denied;

    let request: ValidatedExportRequest;
    try {
      request = validateDataTableExportRequest(req.body, config);
    } catch (err) {
      if (err instanceof z.ZodError) return reply.code(400).send(validationError(err));
      throw err;
    }
    const total = await countDataTableExport(db, config, request, ctx);
    const maxRows = exportConfig!.maxRows[request.format]!;
    if (total > maxRows) return reply.code(413).send(tooLarge(new ExportTooLargeError(total, maxRows)));
    if (busy()) return reply.code(429).header("retry-after", "5").send(busyBody());

    const ticket = createTicketId();
    const ttlMs = exportConfig!.ticketTtlMs;
    try {
      await ticketStore.set(ticket, { body: req.body, ctx }, ttlMs);
    } catch (err) {
      // Limit on the number of pending tickets: a user who is authorized to export cannot fill the process memory by minting tickets.
      if (err instanceof ExportTicketStoreFullError) return reply.code(429).header("retry-after", "5").send({ error: "Too Many Exports", code: "export_busy", message: err.message });
      throw err;
    }
    return reply.header("cache-control", "no-store").send({ ticket, total, filename: request.filename, expiresAt: new Date(Date.now() + ttlMs).toISOString() });
  };

  // Native download: no headers, `ctx` comes from the ticket. Error responses
  // are also `attachment`, so that the browser does not navigate away from the
  // application to an error page.
  const sendDownloadError = (reply: FastifyReply) => (code: number, body: Record<string, unknown>) =>
    reply
      .code(code)
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", contentDisposition("export-error.txt"))
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .send(`${String(body.error)}: ${String(body.message)}\n`);

  const exportDownloadHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const fail = sendDownloadError(reply);
    if (!config.export) return fail(404, { error: "Not Found", code: "export_disabled", message: "Server-side export is disabled on this endpoint" });
    const raw = (req.query as Record<string, unknown> | undefined)?.ticket;
    const id = typeof raw === "string" && TICKET_ID_PATTERN.test(raw) ? raw : null;
    const stored = id ? await ticketStore.take(id) : undefined;
    if (!stored) return fail(410, { error: "Gone", code: "ticket_gone", message: "The download ticket is invalid, already used or expired; start the export again." });

    const ctx = stored.ctx as Ctx;
    const denied = await authorizeExport(ctx, fail);
    if (denied) return denied;
    let request: ValidatedExportRequest;
    try {
      request = validateDataTableExportRequest(stored.body, config);
    } catch (err) {
      if (err instanceof z.ZodError) return fail(400, validationError(err));
      throw err;
    }
    // The slot is reserved before the first `await` (opening the transaction); it is given back on every
    // error path, and once the stream has started it is given back when the body closes (finished, cancelled, failed).
    const release = reserveExportSlot();
    if (!release) return fail(429, busyBody());

    try {
      // The header is built BEFORE the source is opened: everything that can throw happens before the transaction.
      const disposition = contentDisposition(request.filename);
      const opened = await openDataTableExport(db, config, request, ctx, { onHookError: onHookError(req) });
      opened.body.once("close", release);
      try {
        return sendFile(reply, opened, disposition);
      } catch (err) {
        // The body will never be read: if it is not destroyed, the cursor and the transaction would stay open.
        opened.body.destroy();
        throw err;
      }
    } catch (err) {
      release();
      if (err instanceof ExportTooLargeError) return fail(413, tooLarge(err));
      // Fastify's JSON 500 would take the browser to an error page for an API on a different origin.
      req.log.error({ err }, "[datatablex] could not start the export download");
      return fail(500, { error: "Internal Server Error", code: "export_failed", message: "Could not start the export" });
    }
  };

  type RouteFn = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /**
   * An unexpected error (one without a `statusCode`: `InvalidScopeError`, a database error, a plain
   * `Error` from `getContext` …) reaches the client as a 500 `internal_error` that carries no detail;
   * the original error reaches Fastify's error log and the application's `setErrorHandler` in `cause`.
   */
  const guard =
    (route: RouteFn): RouteFn =>
    async (req, reply) => {
      try {
        return await route(req, reply);
      } catch (err) {
        throw toPublicError(err);
      }
    };
  /** On the download route the error is also an `attachment` (so that the browser does not navigate to a JSON 500 page); see `guard`. */
  const guardDownload =
    (route: RouteFn): RouteFn =>
    async (req, reply) => {
      try {
        return await route(req, reply);
      } catch (err) {
        if (reply.sent) throw err;
        const publicError = toPublicError(err) as { statusCode: number; name: string; message: string };
        if (publicError instanceof DataTableInternalError) req.log.error({ err }, "[datatablex] export download failed with an unexpected error");
        return sendDownloadError(reply)(publicError.statusCode, { error: publicError.name, message: publicError.message });
      }
    };

  return Object.assign(guard(handler), { meta: guard(metaHandler), options: guard(optionsHandler), exportTicket: guard(exportTicketHandler), exportDownload: guardDownload(exportDownloadHandler) });
}
