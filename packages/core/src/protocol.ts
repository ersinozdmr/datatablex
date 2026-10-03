/**
 * The version of the DataTableX wire protocol. The meaning of
 * `DataTableQuery`, `DataTableResult` and the meta response depends on this
 * version. The client puts this value on every request in
 * `DATATABLEX_PROTOCOL_HEADER`; the server rejects a version it does not
 * support with an explicit 400. When the header is absent, the version is
 * taken to be `1`. A change that breaks the wire format increases this number.
 */
export const DATATABLEX_PROTOCOL_VERSION = 1;

/** The HTTP header name (lowercase; Node and Fastify read headers in lowercase). */
export const DATATABLEX_PROTOCOL_HEADER = "x-datatablex-protocol";

/**
 * The HTTP header name that carries the number of rows streamed in a server
 * export response (the COUNT taken in the export's own snapshot). The client
 * shows progress and, when the stream ends, compares this with the number of
 * rows it read to catch a file that was cut off midway.
 */
export const DATATABLEX_TOTAL_HEADER = "x-datatablex-total";
