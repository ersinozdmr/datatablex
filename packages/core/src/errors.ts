/**
 * Machine-readable error codes. The server sends them in the `code` field of
 * the error body; the client translates the code into its own language
 * (`message` is in the server's language and cannot be localized). It is a
 * closed set: adding a code is a minor release, so recognizers ignore an
 * unknown code and fall back to `message`.
 */
export const DATA_TABLE_ERROR_CODES = [
  // Server to client
  "unsupported_protocol",
  "forbidden",
  "export_forbidden",
  "validation",
  "field_not_allowed",
  "invalid_filter_value",
  "search_not_supported",
  "export_disabled",
  "export_too_large",
  "export_busy",
  "ticket_gone",
  "export_failed",
  /** The options resolver returned a list longer than `maxOptions` (500, a deployment error). */
  "options_too_large",
  /** An unexpected server error (deployment or database); the detail is not sent to the client and goes to the server log. */
  "internal_error",
  // Errors the client raises itself (before an export)
  "no_rows_selected",
  "export_table_loading",
  "export_no_columns",
  "export_selection_key",
  "export_incomplete",
] as const;

/** One of the codes in `DATA_TABLE_ERROR_CODES`. */
export type DataTableErrorCode = (typeof DATA_TABLE_ERROR_CODES)[number];

/**
 * The JSON body of a backend's 4xx/5xx response. `message` is always present;
 * `error` is the HTTP status text or a short title. The other fields appear
 * only in the relevant case. If a backend other than Fastify conforms to this
 * shape, `@datatablex/react` handles the error the same way.
 */
export interface DataTableErrorBody {
  /** The HTTP status text or a short title. */
  error?: string;
  /** A human-readable message, in the server's language. */
  message: string;
  /** The machine-readable error code. */
  code?: DataTableErrorCode;
  /** `validation` (400): the detail of the problems; its shape depends on the server. */
  details?: unknown;
  /** `export_too_large` (413): the requested row count. */
  total?: number;
  /** `export_too_large` (413): the row ceiling. */
  maxRows?: number;
  /** `export_busy` (429): the number of exports the server runs at once. */
  maxConcurrent?: number;
  /** `unsupported_protocol` (400): the protocol versions the server supports. */
  supported?: number[];
}

const CODES = new Set<unknown>(DATA_TABLE_ERROR_CODES);

/** Type guard: whether `val` is one of the known `DATA_TABLE_ERROR_CODES`. */
export function isDataTableErrorCode(val: unknown): val is DataTableErrorCode {
  return CODES.has(val);
}

/** Type guard that checks only the `message` field of the envelope; an unknown `code` is not a problem (see `dataTableErrorCode`). */
export function isDataTableErrorBody(val: unknown): val is DataTableErrorBody {
  return typeof val === "object" && val !== null && typeof (val as { message?: unknown }).message === "string";
}

/**
 * Reads the recognized `code` from an error (or a body); `undefined` if there
 * is none or it is unknown. Because it is structural, it works even when two
 * copies of `@datatablex/react` are installed (`instanceof` would not).
 *
 * @example
 * ```ts
 * dataTableErrorCode({ code: "export_busy" }); // "export_busy"
 * dataTableErrorCode({ code: "something_else" }); // undefined
 * ```
 */
export function dataTableErrorCode(err: unknown): DataTableErrorCode | undefined {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return isDataTableErrorCode(code) ? code : undefined;
}
