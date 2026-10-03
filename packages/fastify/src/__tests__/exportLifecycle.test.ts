import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { assertValidEndpointConfig } from "../config.js";
import { datatableRoute } from "../datatableRoute.js";
import { ExportTicketStoreFullError, ExportTimeoutError } from "../errors.js";
import { contentDisposition, openDataTableExport, validateDataTableExportRequest } from "../export.js";
import { createMemoryTicketStore } from "../ticket.js";
import type { DataTableEndpointConfig, DataTableExportConfig, DataTableExportEvent } from "../types.js";
import type { RecordedQuery, TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

type Config = DataTableEndpointConfig<TestDB, "access_logs">;

function config(exportConfig: DataTableExportConfig = {}): Config {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"], sortable: true },
      stadiumName: { column: "stadium_name", type: "text", filterOperators: ["contains"] },
    },
    getContext: () => ({ userId: "u1", roles: ["read"] }),
    authorize: () => true,
    export: exportConfig,
  };
}

const rows = [
  { id: 1, stadiumName: "Ali Sami Yen" },
  { id: 2, stadiumName: "Inonu Stadium" },
];
const respond = (rowCount: number) => (q: RecordedQuery) => (/count\(\*\)/.test(q.sql) ? [{ total: String(rowCount) }] : []);

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

async function app(cfg: Config, db: Kysely<TestDB>) {
  const server = Fastify();
  const handler = datatableRoute(db, cfg);
  server.post("/q/export/ticket", handler.exportTicket);
  server.get("/q/export/download", handler.exportDownload);
  await server.ready();
  return server;
}
type Server = Awaited<ReturnType<typeof app>>;

async function ticket(server: Server, payload: object = body()) {
  const response = await server.inject({ method: "POST", url: "/q/export/ticket", payload });
  expect(response.statusCode).toBe(200);
  return response.json().ticket as string;
}
const download = (server: Server, id: string) => server.inject({ method: "GET", url: `/q/export/download?ticket=${id}` });

describe("maxConcurrent — the slot is reserved BEFORE the transaction opens", () => {
  it("concurrent downloads arriving while the transaction is opening get 429; one gets 200", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { db, events } = fakeExecutableDb(respond(2), { stream: () => rows, beforeBegin: () => gate });
    const server = await app(config({ maxConcurrent: 1 }), db);
    const [a, b, c] = [await ticket(server), await ticket(server), await ticket(server)];

    // `inject` is lazy (the chain starts when `then` is called); `Promise.resolve` starts all three immediately.
    const first = Promise.resolve(download(server, a));
    const second = Promise.resolve(download(server, b));
    const third = Promise.resolve(download(server, c));
    // The first is still opening its transaction (waiting at the gate); the other two are rejected immediately.
    const [rejected2, rejected3] = await Promise.all([second, third]);
    expect([rejected2.statusCode, rejected3.statusCode]).toEqual([429, 429]);
    expect(events).toEqual([]);

    open();
    expect((await first).statusCode).toBe(200);
    // The slot is released when the stream ends.
    await vi.waitFor(async () => expect((await download(server, await ticket(server))).statusCode).toBe(200));
  });

  it("the slot is released if opening fails (no leak)", async () => {
    // Dialect without streaming: no cursor -> 500. The slot must be released every time; the second attempt must NOT be 429.
    const { db } = fakeExecutableDb(respond(2));
    const server = await app(config({ maxConcurrent: 1 }), db);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await download(server, await ticket(server));
      expect(response.statusCode).toBe(500);
    }
  });
});

describe("file name — a lone surrogate does not leak resources", () => {
  it("contentDisposition does not throw on a lone surrogate", () => {
    expect(() => contentDisposition("\ud800.csv")).not.toThrow();
    expect(contentDisposition("a\udc00b.csv")).toContain("filename*=UTF-8''a%EF%BF%BDb.csv");
    expect(contentDisposition("😀.csv")).toContain("%F0%9F%98%80.csv");
  });

  it("a request with a malformed name returns 200, the transaction commits and the slot is free", async () => {
    const onExport = vi.fn();
    const { db, events } = fakeExecutableDb(respond(2), { stream: () => rows });
    const server = await app(config({ maxConcurrent: 1, onExport }), db);
    for (const filename of ["\ud800", "x\udfffy", "😀\ud83d"]) {
      const response = await download(server, await ticket(server, body({ filename })));
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    }
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(3));
    expect(events.filter((event) => event === "commit")).toHaveLength(3);
    expect(events).not.toContain("rollback");
  });
});

describe("a client that does not read, and the time limit", () => {
  // Far above the writer buffer (256 KB): the producer fills the buffer and waits for the consumer.
  const many = Array.from({ length: 30_000 }, (_, i) => ({ id: i + 1, stadiumName: `Stadium number ${i + 1} — a long name`, status: "open" }));

  async function open(exportConfig: DataTableExportConfig) {
    const onExport = vi.fn();
    const cfg = config({ onExport, batchSize: 100, ...exportConfig });
    const { db, events } = fakeExecutableDb(respond(many.length), { stream: () => many });
    const opened = await openDataTableExport(db, cfg, validateDataTableExportRequest(body(), cfg), { userId: "u1", roles: ["read"] });
    return { opened, onExport, events };
  }

  it("if the consumer does not read for idleTimeoutMs the export is cut off: rollback, event failed + ExportTimeoutError(stalled)", async () => {
    const { opened, onExport, events } = await open({ idleTimeoutMs: 150 });
    const reader = opened.body[Symbol.asyncIterator]();
    await reader.next(); // the stream starts; then we stop reading
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const event = onExport.mock.calls[0]![0] as DataTableExportEvent;
    expect(event.outcome).toBe("failed");
    expect(event.error).toBeInstanceOf(ExportTimeoutError);
    expect(event.error).toMatchObject({ kind: "stalled", limitMs: 150 });
    expect(events).toEqual(["begin:repeatable read:read only", "stream-closed", "rollback"]);
    expect(event.rowCount).toBeLessThan(many.length);
  });

  it("a consumer that does not drain the buffer is cut off even after production has finished (small export, buffer not full)", async () => {
    const small = many.slice(0, 3000); // ~180 KB: stays under the writer buffer (256 KB) but fills the Readable buffer
    const onExport = vi.fn();
    const cfg = config({ onExport, batchSize: 500, idleTimeoutMs: 150 });
    const { db, events } = fakeExecutableDb(respond(small.length), { stream: () => small });
    const opened = await openDataTableExport(db, cfg, validateDataTableExportRequest(body(), cfg), { userId: "u1", roles: ["read"] });
    await opened.body[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onExport.mock.calls[0]![0]).toMatchObject({ outcome: "failed" });
    expect(onExport.mock.calls[0]![0].error).toMatchObject({ kind: "stalled" });
    expect(events).toContain("rollback");
    expect(events).not.toContain("commit");
  });

  it("if the body is never read (a connection waiting after the headers), the transaction closes after idleTimeoutMs", async () => {
    const { opened, onExport, events } = await open({ idleTimeoutMs: 150 });
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onExport.mock.calls[0]![0]).toMatchObject({ outcome: "failed" });
    expect(events).toContain("rollback");
    expect(opened.body.destroyed).toBe(true);
  });

  it("an actively reading consumer is not caught by idleTimeoutMs", async () => {
    const { opened, onExport } = await open({ idleTimeoutMs: 150 });
    let text = "";
    for await (const chunk of opened.body) {
      text += String(chunk);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(many.length + 1);
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(onExport.mock.calls[0]![0].outcome).toBe("completed");
  });

  it("maxDurationMs limits the total time: a slow but reading client is cut off too (duration)", async () => {
    const { opened, onExport, events } = await open({ maxDurationMs: 120, idleTimeoutMs: 60_000 });
    const failure = await (async () => {
      try {
        const chunks = opened.body[Symbol.asyncIterator]();
        while (!(await chunks.next()).done) await new Promise((resolve) => setTimeout(resolve, 40));
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(failure).toBeInstanceOf(ExportTimeoutError);
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(onExport.mock.calls[0]![0]).toMatchObject({ outcome: "failed" });
    expect(onExport.mock.calls[0]![0].error).toMatchObject({ kind: "duration", limitMs: 120 });
    expect(events).toContain("rollback");
  });

  describe("maxDurationMs also covers opening", () => {
    const ctx = { userId: "u1", roles: ["read"] };
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const isCount = (q: RecordedQuery) => /count\(\*\)/.test(q.sql);
    const statementTimeouts = (calls: RecordedQuery[]) =>
      calls.flatMap((q) => /^set local statement_timeout = (\d+)$/.exec(q.sql)?.slice(1).map(Number) ?? []);

    it("if a slow COUNT exceeds the time limit, opening stops with ExportTimeoutError(duration): rollback, event failed", async () => {
      const onExport = vi.fn();
      const cfg = config({ onExport, maxDurationMs: 80 });
      let finishCount!: () => void;
      const countGate = new Promise<void>((resolve) => (finishCount = resolve));
      const { db, events, calls } = fakeExecutableDb(async (q) => (isCount(q) ? (await countGate, [{ total: "2" }]) : []), { stream: () => rows });
      const startedAt = Date.now();
      try {
        await expect(openDataTableExport(db, cfg, validateDataTableExportRequest(body(), cfg), ctx)).rejects.toMatchObject({
          name: "ExportTimeoutError",
          kind: "duration",
          limitMs: 80,
        });
        expect(Date.now() - startedAt).toBeLessThan(1000);
        expect(events).toEqual(["begin:repeatable read:read only", "rollback"]);
        expect(onExport).toHaveBeenCalledTimes(1);
        expect(onExport.mock.calls[0]![0]).toMatchObject({ outcome: "failed", error: { kind: "duration" } });
        // The remaining time is also the limit in the database.
        const [timeout] = statementTimeouts(calls);
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThanOrEqual(80);
      } finally {
        finishCount();
      }
    });

    it("a slow first cursor read is also subject to the time limit; the cursor is closed and the transaction rolled back", async () => {
      const onExport = vi.fn();
      const cfg = config({ onExport, maxDurationMs: 80 });
      // The fake cursor returns the first batch after 300 ms; in real PostgreSQL `statement_timeout` would cut the read.
      const { db, events } = fakeExecutableDb(respond(2), { stream: async () => (await sleep(300), rows) });
      await expect(openDataTableExport(db, cfg, validateDataTableExportRequest(body(), cfg), ctx)).rejects.toMatchObject({ kind: "duration" });
      expect(events).toEqual(["begin:repeatable read:read only", "stream-closed", "rollback"]);
      expect(onExport.mock.calls[0]![0]).toMatchObject({ outcome: "failed" });
    });

    it("statement_timeout is the smaller of the remaining time and statementTimeoutMs; the default limit is 10 minutes, and Infinity disables the limit", async () => {
      const open = async (exportConfig: DataTableExportConfig) => {
        const cfg = config(exportConfig);
        const { db, calls } = fakeExecutableDb(respond(2), { stream: () => rows });
        const opened = await openDataTableExport(db, cfg, validateDataTableExportRequest(body(), cfg), ctx);
        opened.body.destroy();
        return statementTimeouts(calls);
      };
      expect(await open({ statementTimeoutMs: 50, maxDurationMs: 60_000 })).toEqual([50]);
      const [fromDeadline] = await open({ statementTimeoutMs: 120_000, maxDurationMs: 1000 });
      expect(fromDeadline).toBeGreaterThan(900);
      expect(fromDeadline).toBeLessThanOrEqual(1000);
      expect(await open({ statementTimeoutMs: 70 })).toEqual([70]);
      // If neither is given, the remainder of the default 10 minutes.
      const [fromDefault] = await open({});
      expect(fromDefault).toBeGreaterThan(590_000);
      expect(fromDefault).toBeLessThanOrEqual(600_000);
      // `Infinity`: no time limit; statement_timeout only if given explicitly.
      expect(await open({ maxDurationMs: Infinity })).toEqual([]);
      expect(await open({ maxDurationMs: Infinity, statementTimeoutMs: 70 })).toEqual([70]);
    });

    it("on the route, if opening exceeds the time limit the download returns 500 export_failed and the slot is released", async () => {
      let slowNextCount = false;
      const { db } = fakeExecutableDb(
        async (q) => {
          if (isCount(q) && slowNextCount) {
            slowNextCount = false;
            await sleep(300);
          }
          return respond(2)(q);
        },
        { stream: () => rows },
      );
      const server = await app(config({ maxConcurrent: 1, maxDurationMs: 80 }), db);
      const slow = await ticket(server);
      slowNextCount = true;
      const failed = await download(server, slow);
      expect(failed.statusCode).toBe(500);
      expect(failed.body).toContain("Could not start the export");
      expect((await download(server, await ticket(server))).statusCode).toBe(200);
    });
  });

  it("idleTimeoutMs and maxDurationMs must be positive integers", () => {
    for (const key of ["idleTimeoutMs", "maxDurationMs"] as const) {
      expect(() => assertValidEndpointConfig(config({ [key]: 0 }))).toThrow(new RegExp(`export.${key}`));
      expect(() => assertValidEndpointConfig(config({ [key]: 1.5 }))).toThrow(new RegExp(`export.${key}`));
    }
  });

  it("maxDurationMs accepts Infinity; a finite value that would overflow the timer, and NaN, are boot errors", () => {
    expect(() => assertValidEndpointConfig(config({ maxDurationMs: Infinity }))).not.toThrow();
    expect(() => assertValidEndpointConfig(config({ maxDurationMs: 2_147_483_647 }))).not.toThrow();
    for (const bad of [2_147_483_648, Number.NaN, -Infinity]) {
      expect(() => assertValidEndpointConfig(config({ maxDurationMs: bad }))).toThrow(/export\.maxDurationMs must be an integer between 1 and 2147483647/);
    }
  });
});

describe("ticket store ceiling", () => {
  it("set throws when maxTickets is reached; an expired ticket frees a slot; take frees a slot", () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const store = createMemoryTicketStore({ maxTickets: 2 });
      store.set("a", { body: 1, ctx: 1 }, 1000);
      store.set("b", { body: 2, ctx: 2 }, 5000);
      expect(() => store.set("c", { body: 3, ctx: 3 }, 1000)).toThrow(ExportTicketStoreFullError);
      vi.setSystemTime(1_001_500); // "a" has expired
      expect(() => store.set("c", { body: 3, ctx: 3 }, 1000)).not.toThrow();
      expect(() => store.set("d", { body: 4, ctx: 4 }, 1000)).toThrow(/reached the limit \(2\)/);
      expect(store.take("b")).toBeDefined();
      expect(() => store.set("d", { body: 4, ctx: 4 }, 1000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the default ceiling is 1,000; an invalid maxTickets is a boot error", () => {
    const store = createMemoryTicketStore();
    for (let i = 0; i < 1000; i++) store.set(`t${i}`, { body: i, ctx: i }, 60_000);
    expect(() => store.set("extra", { body: 0, ctx: 0 }, 60_000)).toThrow(ExportTicketStoreFullError);
    expect(() => createMemoryTicketStore({ maxTickets: 0 })).toThrow(/maxTickets/);
  });

  it("the ticket route returns 429 + export_busy + Retry-After when the store is full; download still works", async () => {
    const { db } = fakeExecutableDb(respond(2), { stream: () => rows });
    const server = await app(config({ ticketStore: createMemoryTicketStore({ maxTickets: 1 }) }), db);
    const first = await ticket(server);
    const full = await server.inject({ method: "POST", url: "/q/export/ticket", payload: body() });
    expect(full.statusCode).toBe(429);
    expect(full.headers["retry-after"]).toBe("5");
    expect(full.json()).toMatchObject({ code: "export_busy" });
    expect((await download(server, first)).statusCode).toBe(200);
    // The downloaded ticket freed a slot.
    expect((await server.inject({ method: "POST", url: "/q/export/ticket", payload: body() })).statusCode).toBe(200);
  });
});
