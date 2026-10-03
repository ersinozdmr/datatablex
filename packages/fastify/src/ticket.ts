import { randomBytes } from "node:crypto";
import { ExportTicketStoreFullError } from "./errors.js";

/** Default maximum number of tickets the in-process store can hold at once; each one keeps the raw request body (at most `bodyLimit`). */
export const DEFAULT_MAX_TICKETS = 1000;

/**
 * What a ticket stores: the raw request body and the `ctx` of the user who
 * obtained the ticket. At download time the body is validated AGAIN with the
 * config of that route, and `authorize`/`export.authorize` run again with the
 * stored `ctx`. So even if, in a shared store, one endpoint's ticket is used on
 * another endpoint's download route, it grants no more than its owner could
 * already do on that endpoint.
 */
export interface DataTableExportTicketData {
  /** The raw export request body, exactly as the client sent it. */
  body: unknown;
  /** The request context of the user who obtained the ticket. */
  ctx: unknown;
}

/**
 * Ticket store. `take` must read and delete the ticket ATOMICALLY: a ticket is
 * single-use. For an expired ticket it returns `undefined`.
 *
 * The default (`createMemoryTicketStore`) is in-process; with several server
 * instances a ticket may land on a different instance than the one that issued
 * it. In that case provide a shared store (Redis `SET PX` + `GETDEL`, etc.);
 * `ctx` must then be JSON-serializable.
 */
export interface DataTableExportTicketStore {
  /** Stores a ticket under `id`; it expires after `ttlMs` milliseconds. May throw, for example `ExportTicketStoreFullError` when the store is full. */
  set(id: string, data: DataTableExportTicketData, ttlMs: number): void | Promise<void>;
  /** Atomically reads and deletes the ticket under `id`. Returns `undefined` when it is missing or expired. */
  take(id: string): DataTableExportTicketData | undefined | Promise<DataTableExportTicketData | undefined>;
}

/**
 * In-process ticket store. Expired tickets are purged on every `set`; once the
 * number of pending tickets reaches `maxTickets`, `set` throws
 * `ExportTicketStoreFullError` and the ticket route responds with 429. The limit
 * stops an authorized user from creating unlimited tickets within 60 seconds
 * and filling the process memory (each ticket holds the raw request body).
 *
 * @example
 * ```ts
 * const ticketStore = createMemoryTicketStore({ maxTickets: 500 });
 * ```
 *
 * @param options.maxTickets - Maximum number of pending tickets.
 * @default 1000 (`DEFAULT_MAX_TICKETS`)
 * @throws {Error} When `maxTickets` is not a positive safe integer.
 */
export function createMemoryTicketStore(options: { maxTickets?: number } = {}): DataTableExportTicketStore {
  const maxTickets = options.maxTickets ?? DEFAULT_MAX_TICKETS;
  if (!Number.isSafeInteger(maxTickets) || maxTickets < 1) throw new Error(`createMemoryTicketStore maxTickets must be a positive safe integer, received: ${String(maxTickets)}`);
  const tickets = new Map<string, { data: DataTableExportTicketData; expiresAt: number }>();
  return {
    set(id, data, ttlMs) {
      const now = Date.now();
      for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
      if (tickets.size >= maxTickets) throw new ExportTicketStoreFullError(maxTickets);
      tickets.set(id, { data, expiresAt: now + ttlMs });
    },
    take(id) {
      const entry = tickets.get(id);
      tickets.delete(id);
      return entry && entry.expiresAt > Date.now() ? entry.data : undefined;
    },
  };
}

/** Creates a ticket id: 32 random bytes, base64url-encoded so it can be carried in a URL without escaping. */
export function createTicketId(): string {
  return randomBytes(32).toString("base64url");
}

/** Pattern that a valid ticket id (the format `createTicketId` generates) matches; malformed values are rejected without a store lookup. */
export const TICKET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
