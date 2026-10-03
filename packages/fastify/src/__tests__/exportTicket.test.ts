import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { datatableRoute } from "../datatableRoute.js";
import { createMemoryTicketStore } from "../ticket.js";
import type { DataTableExportTicketStore } from "../ticket.js";
import type { DataTableEndpointConfig, DataTableExportConfig } from "../types.js";
import type { RecordedQuery, TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

type Config = DataTableEndpointConfig<TestDB, "access_logs">;

function config(exportConfig: DataTableExportConfig = {}, overrides: Partial<Config> = {}): Config {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"], sortable: true },
      stadiumName: { column: "stadium_name", type: "text", sortable: true, filterOperators: ["contains"] },
      status: { column: "status", type: "enum", filterOperators: ["eq", "in"] },
    },
    getContext: (req) => ({ userId: String(req.headers["x-user"] ?? "u1"), roles: String(req.headers["x-roles"] ?? "read,export").split(",") }),
    authorize: (ctx) => ctx.roles.includes("read"),
    export: { authorize: (ctx) => ctx.roles.includes("export"), ...exportConfig },
    ...overrides,
  };
}

const rows = [
  { id: 1, stadiumName: "Ali Sami Yen", status: "open" },
  { id: 2, stadiumName: "Inonu Stadium", status: "closed" },
];

function source(streamRows: Array<Record<string, unknown>> = rows, total = streamRows.length) {
  return fakeExecutableDb((q: RecordedQuery) => (/count\(\*\)/.test(q.sql) ? [{ total: String(total) }] : []), { stream: () => streamRows });
}

const body = (overrides: Record<string, unknown> = {}) => ({
  query: { sorting: [], filters: null },
  format: "csv",
  columns: [
    { field: "id", title: "No" },
    { field: "stadiumName", title: "Stadium" },
  ],
  filename: "entries",
  ...overrides,
});

async function app(cfg: Config, db = source().db) {
  const server = Fastify();
  const handler = datatableRoute(db, cfg);
  server.post("/q/export/ticket", handler.exportTicket);
  server.get("/q/export/download", handler.exportDownload);
  await server.ready();
  return server;
}

type Server = Awaited<ReturnType<typeof app>>;

async function ticketFor(server: Server, payload = body(), headers: Record<string, string> = {}) {
  const response = await server.inject({ method: "POST", url: "/q/export/ticket", payload, headers });
  expect(response.statusCode).toBe(200);
  return response.json() as { ticket: string; total: number; filename: string; expiresAt: string };
}

const download = (server: Server, ticket: string) => server.inject({ method: "GET", url: `/q/export/download?ticket=${encodeURIComponent(ticket)}` });

afterEach(() => {
  vi.useRealTimers();
});

describe("export ticket", () => {
  it("a request that passes the gates gets a single-use ticket; the ticket downloads the file", async () => {
    const onExport = vi.fn();
    const server = await app(config({ onExport }));
    const issued = await ticketFor(server);
    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued).toMatchObject({ total: 2, filename: "entries.csv" });
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(50_000);

    const file = await download(server, issued.ticket);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(file.headers["content-disposition"]).toContain("attachment;");
    expect(file.headers["cache-control"]).toBe("no-store");
    expect(file.headers["x-datatablex-total"]).toBe("2");
    expect(file.body.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean)).toEqual(['"No","Stadium"', '"1","Ali Sami Yen"', '"2","Inonu Stadium"']);
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    // The identity of the download comes from the ticket.
    expect(onExport.mock.calls[0]![0].ctx).toEqual({ userId: "u1", roles: ["read", "export"] });

    // Single use: the second download returns 410 - and as a file, not a page.
    const again = await download(server, issued.ticket);
    expect(again.statusCode).toBe(410);
    expect(again.headers["content-disposition"]).toContain('filename="export-error.txt"');
    expect(again.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("the ticket passes the same gates: authorize, export.authorize, validation, early 413", async () => {
    const server = await app(config({ maxRows: 1 }));
    expect((await server.inject({ method: "POST", url: "/q/export/ticket", payload: body(), headers: { "x-roles": "export" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/q/export/ticket", payload: body(), headers: { "x-roles": "read" } })).statusCode).toBe(403);
    const invalid = await server.inject({ method: "POST", url: "/q/export/ticket", payload: body({ format: "pdf" }) });
    expect(invalid.statusCode).toBe(400);
    const tooLarge = await server.inject({ method: "POST", url: "/q/export/ticket", payload: body() });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({ total: 2, maxRows: 1 });
    const protocol = await server.inject({ method: "POST", url: "/q/export/ticket", payload: body(), headers: { "x-datatablex-protocol": "99" } });
    expect(protocol.statusCode).toBe(400);
  });

  it("a malformed, unknown or expired ticket gets 410", async () => {
    const server = await app(config({ ticketTtlMs: 1_000 }));
    expect((await download(server, "short")).statusCode).toBe(410);
    expect((await download(server, "A".repeat(43))).statusCode).toBe(410);
    expect((await server.inject({ method: "GET", url: "/q/export/download" })).statusCode).toBe(410);

    const issued = await ticketFor(server);
    vi.useFakeTimers({ now: Date.now() + 1_001, toFake: ["Date"] });
    expect((await download(server, issued.ticket)).statusCode).toBe(410);
  });

  it("the download re-checks authorization with the ctx in the ticket and re-validates the request with this route's config", async () => {
    const store = createMemoryTicketStore();
    const wide = await app(config({ ticketStore: store }));
    // Second endpoints sharing the same store: one does not expose `stadiumName` to export, the other narrows export authorization.
    const narrow = await app(config({ ticketStore: store, fields: ["id"] }));
    const strict = await app(config({ ticketStore: store, authorize: (ctx) => ctx.userId === "admin" }));

    const rejected = await download(narrow, (await ticketFor(wide)).ticket);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.headers["content-disposition"]).toContain("export-error.txt");
    expect(rejected.body).toContain("columns.1.field");

    const forbidden = await download(strict, (await ticketFor(wide)).ticket);
    expect(forbidden.statusCode).toBe(403);
  });

  it("custom ticket store: set and take carry the ticket; take enforces single use", async () => {
    const saved = new Map<string, unknown>();
    const store: DataTableExportTicketStore = {
      set: vi.fn(async (id, data, ttlMs) => {
        expect(ttlMs).toBe(60_000);
        saved.set(id, JSON.parse(JSON.stringify(data)));
      }),
      take: vi.fn(async (id) => {
        const data = saved.get(id) as ReturnType<DataTableExportTicketStore["take"]>;
        saved.delete(id);
        return data;
      }),
    };
    const server = await app(config({ ticketStore: store }));
    const issued = await ticketFor(server);
    expect(store.set).toHaveBeenCalledWith(issued.ticket, { body: body(), ctx: { userId: "u1", roles: ["read", "export"] } }, 60_000);
    expect((await download(server, issued.ticket)).statusCode).toBe(200);
    expect((await download(server, issued.ticket)).statusCode).toBe(410);
  });

  it("maxConcurrent: while an export is streaming, tickets and downloads get 429; the slot frees when the connection drops", async () => {
    // ~30 MB CSV: does not fit in socket buffers, so an unread download stays open.
    const many = Array.from({ length: 200_000 }, (_, i) => ({ id: i + 1, stadiumName: `Stadium ${i} ${"x".repeat(120)}`, status: "open" }));
    const server = await app(config({ maxConcurrent: 1, maxRows: 1_000_000 }), source(many).db);
    // A real HTTP connection: the download is held open and then dropped (inject's fake response does not simulate a dropped connection).
    const address = await server.listen({ port: 0, host: "127.0.0.1" });
    try {
      const first = await ticketFor(server);
      const second = await ticketFor(server);

      const controller = new AbortController();
      const open = await fetch(`${address}/q/export/download?ticket=${first.ticket}`, { signal: controller.signal });
      expect(open.status).toBe(200);
      const reader = open.body!.getReader();
      await reader.read();

      const busyTicket = await server.inject({ method: "POST", url: "/q/export/ticket", payload: body() });
      expect(busyTicket.statusCode).toBe(429);
      expect(busyTicket.headers["retry-after"]).toBe("5");
      expect(busyTicket.json()).toMatchObject({ maxConcurrent: 1 });
      const busyDownload = await download(server, second.ticket);
      expect(busyDownload.statusCode).toBe(429);
      expect(busyDownload.headers["content-disposition"]).toContain("export-error.txt");

      controller.abort();
      await vi.waitFor(async () => expect((await server.inject({ method: "POST", url: "/q/export/ticket", payload: body() })).statusCode).toBe(200), {
        timeout: 5_000,
      });
    } finally {
      // After the dropped download the client (undici) opens a new connection that sends no request;
      // on Linux/Node 20 `close()` does not close this idle connection by itself and waits forever.
      server.server.closeAllConnections();
      await server.close();
    }
    // The inner `waitFor` can wait up to 5 s; the test timeout must be above that.
  }, 15_000);
});
