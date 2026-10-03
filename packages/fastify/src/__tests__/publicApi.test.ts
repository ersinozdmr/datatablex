import { describe, expect, it } from "vitest";
import * as api from "../index.js";

/**
 * The root entry is the supported surface; a new export is a semver commitment.
 * This list is kept by hand on purpose, so that adding or removing an export is visible here.
 */
describe("@datatablex/fastify root exports", () => {
  it("exposes only the supported runtime surface", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "DataTableInternalError",
        "ExportStreamingUnavailableError",
        "ExportTicketStoreFullError",
        "ExportTimeoutError",
        "ExportTooLargeError",
        "FieldNotAllowedError",
        "InvalidFilterValueError",
        "InvalidScopeError",
        "OptionsTooLargeError",
        "SUPPORTED_PROTOCOL_VERSIONS",
        "SearchNotSupportedError",
        "UnsupportedProtocolError",
        "assertValidEndpointConfig",
        "createMemoryTicketStore",
        "datatableRoute",
        "describeDataTableEndpoint",
      ].sort(),
    );
  });

  it("internals that bypass the identity gates are not exported", () => {
    for (const internal of ["handleDataTableQuery", "validateDataTableQuery", "openDataTableExport", "countDataTableExport", "filterExpression", "leafExpression", "escapeLike"]) {
      expect(api).not.toHaveProperty(internal);
    }
  });
});
