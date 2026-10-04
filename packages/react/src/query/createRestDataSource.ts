import { DATATABLEX_PROTOCOL_HEADER, DATATABLEX_PROTOCOL_VERSION, dataTableErrorCode, isDataTableEndpointMeta, isDataTableFieldOptions, isDataTableResultEnvelope } from "@datatablex/core";
import type {
  DataTableErrorCode, DataSource, DataTableEndpointMeta, DataTableFieldOption, DataTableExportDownload, DataTableExportRequest, DataTableExportTicket, DataTableQuery, DataTableResult } from "@datatablex/core";

/** Options of `createRestDataSource`. */
export interface RestDataSourceOptions {
  /** URL that receives the query: the `POST` route registered by `datatableRoute(...)` from `@datatablex/fastify`. */
  endpoint: string;
  /**
   * HTTP method of the query request. Fixed to `POST` because nested filters
   * and sorts do not fit in a query string.
   *
   * @default "POST"
   */
  method?: "POST";
  /**
   * Headers sent with every request. The function form supports cases where a
   * fresh header must be produced for each request, such as refreshing a token.
   */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /**
   * The `GET` URL where `datatableRoute(...).meta` is registered. When it is
   * given, the table reads its limits and the column operators from there; if
   * the metadata cannot be fetched, it keeps working with the values given by
   * hand or the defaults.
   */
  metaEndpoint?: string;
  /**
   * Base URL of the server export. The ticket is requested with
   * `POST ${exportEndpoint}/ticket` (`datatableRoute(...).exportTicket`) and
   * the file is downloaded from `GET ${exportEndpoint}/download?ticket=…`
   * (`exportDownload`). When it is not given and `metaEndpoint` is given,
   * `${endpoint}/export` is assumed; the table uses it only when the metadata
   * `export` block announces it. `false` turns the server export off.
   *
   * The download is the browser's own request and does not carry `headers`:
   * the identity comes from the ticket. For an API on a different origin, the
   * download URL must be a full URL
   * (`exportEndpoint: "https://api.example.com/x/export"`).
   *
   * @default `${endpoint}/export` when `metaEndpoint` is given, otherwise the server export is off
   */
  exportEndpoint?: string | false;
  /**
   * Base URL of the options route: the filter options of a field are read from
   * `GET ${optionsEndpoint}/<field>` (`datatableRoute(...).options`, which is
   * registered as `/options/:field`). When it is not given and `metaEndpoint`
   * is given, `${endpoint}/options` is assumed; the table uses it only when the
   * metadata reports `hasOptions` for the field and the column has no
   * hand-written `options`. `false` turns the server options off.
   *
   * @default `${endpoint}/options` when `metaEndpoint` is given, otherwise the server options are off
   * @experimental May change in any release while the package is in 0.x.
   */
  optionsEndpoint?: string | false;
}

/**
 * The error thrown for a non-OK server response (`!res.ok`). Because it
 * carries `status`, the caller can tell a client error (4xx: sending the same
 * query again gives the same result) from a transient server or network error
 * (5xx). The default error view of `<DataTable>` puts the action that clears
 * the query ahead of "Retry" on a 4xx.
 */
export class DataTableRequestError extends Error {
  /** HTTP status code of the response. */
  readonly status: number;
  /** The parsed response body, or `null` when it could not be parsed as JSON. */
  readonly body: unknown;
  /** The recognized `code` of the body (see `DataTableErrorBody`); `undefined` if there is none or it is unknown. */
  readonly code: DataTableErrorCode | undefined;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "DataTableRequestError";
    this.status = status;
    this.body = body;
    this.code = dataTableErrorCode(body);
  }
}

/**
 * Tells whether `err` is a `DataTableRequestError`. The check is structural
 * instead of `instanceof`: the consumer's copy of `@datatablex/react` and the
 * copy seen by `@datatablex/antd` can differ (version skew), and `instanceof`
 * would then silently return `false`.
 */
export function isDataTableRequestError(err: unknown): err is DataTableRequestError {
  return err instanceof Error && err.name === "DataTableRequestError" && typeof (err as { status?: unknown }).status === "number";
}

async function resolveHeaders(headers: RestDataSourceOptions["headers"]): Promise<Record<string, string>> {
  if (!headers) return {};
  return typeof headers === "function" ? await headers() : headers;
}

async function errorFromResponse(res: Response, endpoint: string): Promise<DataTableRequestError> {
  const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
  // `message` is read FIRST: server errors that carry `statusCode`
  // (FieldNotAllowedError, SearchNotSupportedError, InvalidFilterValueError)
  // go through Fastify's default handler, where the `error` field is the HTTP
  // status text ("Bad Request") and the actual message is only in `message`.
  // The `error` fallback is kept for bodies that carry no `message`.
  return new DataTableRequestError(
    body?.message ?? body?.error ?? `[datatablex] the request to ${endpoint} returned ${res.status}`,
    res.status,
    body,
  );
}

/** Tells whether `val` has the shape of a `DataTableExportTicket` returned by the ticket route. */
function isExportTicket(val: unknown): val is DataTableExportTicket {
  if (typeof val !== "object" || val === null) return false;
  const ticket = val as Record<string, unknown>;
  return (
    typeof ticket.ticket === "string" &&
    ticket.ticket.length > 0 &&
    typeof ticket.total === "number" &&
    Number.isSafeInteger(ticket.total) &&
    ticket.total >= 0 &&
    typeof ticket.filename === "string" &&
    typeof ticket.expiresAt === "string"
  );
}

/**
 * Ties a shared request to the caller's signal: aborting only ends that
 * caller's wait, while the request itself (and the other waiters) carries on.
 */
function withAbort<V>(shared: Promise<V>, signal: AbortSignal | undefined, message: string): Promise<V> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(new DOMException(message, "AbortError"));
  return new Promise<V>((resolve, reject) => {
    const onAbort = () => reject(new DOMException(message, "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Added to every request; the server rejects a protocol version it does not support with an explicit 400. */
const protocolHeader = { [DATATABLEX_PROTOCOL_HEADER]: String(DATATABLEX_PROTOCOL_VERSION) };

/**
 * Connects a `DataSource<T>` to a real backend. It sends the `POST` body that
 * `datatableRoute` of `@datatablex/fastify` expects (the raw `DataTableQuery`).
 *
 * `AbortError` is rethrown AS IT IS and is NOT caught here: the fetch effect
 * of `useDataTable` already treats it as "not an error, a newer request
 * replaced the older one" (see `state/useDataTable.ts`). For a non-OK response
 * (`!res.ok`) a `DataTableRequestError` is thrown: its message is taken from
 * the `message` field of the body, then its `error` field, and failing that
 * from the HTTP status; `status` and the raw body are carried on the error.
 *
 * When `metaEndpoint` is given, the returned source also provides `getMeta`
 * (fetched once per instance and cached) and `invalidateMeta`; the options
 * route adds `getOptions`/`invalidateOptions`, and the export route adds
 * `requestExport`.
 *
 * @example
 * ```ts
 * const dataSource = createRestDataSource<Order>({
 *   endpoint: "/api/orders/query",
 *   metaEndpoint: "/api/orders/meta",
 *   headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
 * });
 *
 * const table = useDataTable({ columns, dataSource });
 * ```
 *
 * @throws {DataTableRequestError} When the server answers with a non-OK status.
 * @throws {Error} When a 2xx body is not a valid `DataTableResult` envelope.
 */
export function createRestDataSource<T>(options: RestDataSourceOptions): DataSource<T> {
  const { endpoint, method = "POST", metaEndpoint } = options;
  const exportEndpoint = options.exportEndpoint === false ? null : (options.exportEndpoint ?? (metaEndpoint ? `${endpoint}/export` : null));

  const loadMeta = async (url: string): Promise<DataTableEndpointMeta> => {
    const headers = await resolveHeaders(options.headers);
    const res = await fetch(url, { method: "GET", headers: { ...protocolHeader, ...headers } });
    if (!res.ok) throw await errorFromResponse(res, url);
    const body: unknown = await res.json();
    if (!isDataTableEndpointMeta(body)) {
      throw new Error(`[datatablex] ${url} did not return a recognized metadata definition.`);
    }
    return body;
  };

  // The metadata is fetched ONCE per DataSource instance: returning to the
  // same page, or a second table that uses the same source, does not request
  // it again. A failed request is not cached. The shared request is not cut
  // short by the abort of a single caller; each caller aborts only its own wait.
  let cachedMeta: Promise<DataTableEndpointMeta> | null = null;
  const getMeta = metaEndpoint
    ? (metaOptions?: { signal?: AbortSignal }): Promise<DataTableEndpointMeta> => {
        if (!cachedMeta) {
          const pending = loadMeta(metaEndpoint);
          cachedMeta = pending;
          pending.catch(() => {
            if (cachedMeta === pending) cachedMeta = null;
          });
        }
        return withAbort(cachedMeta, metaOptions?.signal, "The metadata request was aborted.");
      }
    : undefined;

  const optionsEndpoint = options.optionsEndpoint === false ? null : (options.optionsEndpoint ?? (metaEndpoint ? `${endpoint}/options` : null));
  const loadOptions = async (url: string): Promise<DataTableFieldOption[]> => {
    const headers = await resolveHeaders(options.headers);
    const res = await fetch(url, { method: "GET", headers: { ...protocolHeader, ...headers } });
    if (!res.ok) throw await errorFromResponse(res, url);
    const body: unknown = await res.json();
    if (!isDataTableFieldOptions(body)) {
      throw new Error(`[datatablex] ${url} did not return a recognized option list.`);
    }
    return body.options;
  };
  // Like the metadata, the options are fetched ONCE per field per DataSource
  // instance: reopening the same select, or a second table that uses the same
  // source, does not produce a request. A failed request is not cached.
  const cachedOptions = new Map<string, Promise<DataTableFieldOption[]>>();
  const getOptions = optionsEndpoint
    ? (field: string, fieldOptions?: { signal?: AbortSignal }): Promise<DataTableFieldOption[]> => {
        let pending = cachedOptions.get(field);
        if (!pending) {
          const created = loadOptions(`${optionsEndpoint}/${encodeURIComponent(field)}`);
          pending = created;
          cachedOptions.set(field, created);
          created.catch(() => {
            if (cachedOptions.get(field) === created) cachedOptions.delete(field);
          });
        }
        return withAbort(pending, fieldOptions?.signal, "The options request was aborted.");
      }
    : undefined;
  const invalidateOptions = (field?: string) => {
    if (field === undefined) cachedOptions.clear();
    else cachedOptions.delete(field);
  };

  const requestExport = exportEndpoint
    ? async (request: DataTableExportRequest, exportOptions?: { signal?: AbortSignal }): Promise<DataTableExportDownload> => {
        const url = `${exportEndpoint}/ticket`;
        const headers = await resolveHeaders(options.headers);
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...protocolHeader, ...headers },
          body: JSON.stringify(request),
          signal: exportOptions?.signal,
        });
        if (!res.ok) throw await errorFromResponse(res, url);
        const body: unknown = await res.json();
        if (!isExportTicket(body)) throw new Error(`[datatablex] ${url} did not return a recognized export ticket.`);
        return { ...body, downloadUrl: `${exportEndpoint}/download?ticket=${encodeURIComponent(body.ticket)}` };
      }
    : undefined;

  return {
    ...(requestExport ? { requestExport } : null),
    ...(getMeta
      ? {
          getMeta,
          invalidateMeta: () => {
            cachedMeta = null;
            // A single call is enough when the role changes: the options are also user-specific.
            invalidateOptions();
          },
        }
      : null),
    ...(getOptions ? { getOptions, invalidateOptions } : null),
    async fetch(query: DataTableQuery, fetchOptions?: { signal?: AbortSignal }): Promise<DataTableResult<T>> {
      const headers = await resolveHeaders(options.headers);
      const res = await fetch(endpoint, {
        method,
        headers: { "content-type": "application/json", ...protocolHeader, ...headers },
        body: JSON.stringify(query),
        signal: fetchOptions?.signal,
      });

      if (!res.ok) throw await errorFromResponse(res, endpoint);

      // The rows (`T`) are not validated, but the outer envelope is: a
      // malformed 2xx body (an HTML error page, a proxy response, a wrong
      // endpoint) would otherwise produce `NaN` pagination or an endless
      // export loop.
      const body: unknown = await res.json().catch(() => undefined);
      if (!isDataTableResultEnvelope(body)) {
        throw new Error(`[datatablex] ${endpoint} did not return a valid DataTableResult ({ data: [], pagination: { page, pageSize, total } }).`);
      }
      return body as DataTableResult<T>;
    },
  };
}
