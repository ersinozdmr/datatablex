import { DATATABLEX_PROTOCOL_HEADER } from "@datatablex/core";
import type { FastifyRequest } from "fastify";
import { UnsupportedProtocolError } from "./errors.js";

/** The wire protocol versions this server can understand. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

/**
 * Checks the client's `x-datatablex-protocol` header. If the header is absent
 * the version is taken as `1`, so curl, tests and clients other than
 * `createRestDataSource` do not break. If it is present and not supported (not
 * a number, or not in the list), `UnsupportedProtocolError` (400) is raised:
 * an explicit error instead of a query that is silently misinterpreted.
 *
 * @throws {UnsupportedProtocolError} When the header is not a supported version.
 */
export function assertSupportedProtocol(req: FastifyRequest): void {
  const raw = req.headers[DATATABLEX_PROTOCOL_HEADER];
  if (raw === undefined) return;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const version = value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) throw new UnsupportedProtocolError(String(value), SUPPORTED_PROTOCOL_VERSIONS);
}
