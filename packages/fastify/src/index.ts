export type { BaseCtx, DataTableEndpointConfig, DataTableExportConfig, DataTableExportEvent, DataTableRouteHandler, FieldConfig, FieldType } from "./types.js";
export { datatableRoute } from "./datatableRoute.js";
export { createMemoryTicketStore } from "./ticket.js";
export type { DataTableExportTicketData, DataTableExportTicketStore } from "./ticket.js";
export { describeDataTableEndpoint } from "./describe.js";
export {
  DataTableInternalError,
  ExportStreamingUnavailableError,
  ExportTicketStoreFullError,
  ExportTimeoutError,
  ExportTooLargeError,
  FieldNotAllowedError,
  InvalidFilterValueError,
  InvalidScopeError,
  OptionsTooLargeError,
  SearchNotSupportedError,
  UnsupportedProtocolError,
} from "./errors.js";
export { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.js";

export { assertValidEndpointConfig } from "./config.js";

// `handleDataTableQuery`, `validateDataTableQuery`, `openDataTableExport`,
// `filterExpression` ... are internals of `datatableRoute` and are
// DELIBERATELY not exported from here: only `datatableRoute` applies the
// `getContext`/`authorize` gate, using the internals directly would bypass
// those gates, and it would pull Kysely/export details into the semver
// contract. Tests import the internal modules by relative path.
