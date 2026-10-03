import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { datatableRoute } from "../datatableRoute.js";
import { openDataTableExport, validateDataTableExportRequest } from "../export.js";
import { describeDataTableEndpoint } from "../describe.js";
import type { DataTableEndpointConfig, DataTableExportEvent } from "../types.js";
import type { RecordedQuery, TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

type Config = DataTableEndpointConfig<TestDB, "access_logs">;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"], sortable: true },
      stadiumName: { column: "stadium_name", type: "text", sortable: true, filterOperators: ["eq", "contains"], searchable: true },
      status: { column: "status", type: "enum", filterOperators: ["eq", "in"] },
      nationalId: { column: "nationalId", type: "text", filterOperators: ["eq"], sensitive: true },
    },
    getContext: (req) => ({ userId: "u1", roles: String(req.headers["x-roles"] ?? "access_logs:read").split(",") }),
    authorize: (ctx) => ctx.roles.includes("access_logs:read"),
    export: {},
    ...overrides,
  };
}

const rows = [
  { id: 1, stadiumName: "Ali Sami Yen", status: "open" },
  { id: 2, stadiumName: '=HYPERLINK("x")', status: "closed" },
  { id: 3, stadiumName: "Şükrü Saracoğlu", status: "open" },
];

function source(streamRows: Array<Record<string, unknown>> = rows, total = streamRows.length) {
  return fakeExecutableDb((q: RecordedQuery) => (/count\(\*\)/.test(q.sql) ? [{ total: String(total) }] : []), { stream: () => streamRows });
}

const body = (overrides: Record<string, unknown> = {}) => ({
  query: { sorting: [{ field: "stadiumName", direction: "asc" }], filters: null },
  format: "csv",
  columns: [
    { field: "id", title: "No" },
    { field: "stadiumName", title: "Stadium" },
    { field: "status", title: "Status" },
  ],
  filename: "geçişler",
  ...overrides,
});

async function app(config: Config, db = source().db) {
  const server = Fastify();
  const handler = datatableRoute(db, config);
  server.post("/q/export/ticket", handler.exportTicket);
  server.get("/q/export/download", handler.exportDownload);
  server.get("/q/meta", handler.meta);
  await server.ready();
  return server;
}

/**
 * Runs the ticket + download flow in one step: if the ticket is rejected (400/403/404/413/429) that
 * response is returned, otherwise the file response is. Identity comes from the ticket, so `headers` goes only to the ticket request.
 */
async function runExport(server: Awaited<ReturnType<typeof app>>, payload: unknown, headers: Record<string, string> = {}) {
  const issued = await server.inject({ method: "POST", url: "/q/export/ticket", payload: payload as object, headers });
  if (issued.statusCode !== 200) return issued;
  return server.inject({ method: "GET", url: `/q/export/download?ticket=${encodeURIComponent(issued.json().ticket)}` });
}

describe("export — boot-time rules", () => {
  const { db } = source();

  it("export.fields cannot contain a field outside the projection or a sensitive one", () => {
    expect(() => datatableRoute(db, baseConfig({ export: { fields: ["nationalId"] } }))).toThrow(/is not in the projection/);
    expect(() => datatableRoute(db, baseConfig({ export: { fields: ["ghost"] } }))).toThrow(/is not in the projection/);
    expect(() => datatableRoute(db, baseConfig({ select: ["stadiumName"], export: { fields: ["status"] } }))).toThrow(/is not in the projection/);
    expect(() => datatableRoute(db, baseConfig({ export: { fields: [] } }))).toThrow(/at least one field/);
  });

  it.each(["maxRows", "batchSize", "statementTimeoutMs"] as const)("%s must be a positive integer", (key) => {
    expect(() => datatableRoute(db, baseConfig({ export: { [key]: 0 } }))).toThrow(new RegExp(`export.${key}`));
    expect(() => datatableRoute(db, baseConfig({ export: { [key]: 1.5 } }))).toThrow(new RegExp(`export.${key}`));
  });

  it("hook fields must be functions", () => {
    expect(() => datatableRoute(db, baseConfig({ export: { formatter: "x" as never } }))).toThrow(/export.formatter/);
  });
});

describe("export — meta", () => {
  it("reports the formats and the ceiling when export is enabled, and has no field when it is disabled", () => {
    expect(describeDataTableEndpoint(baseConfig({ export: { maxRows: 50, fields: ["id"] } })).export).toEqual({ formats: { csv: 50 }, fields: ["id"] });
    expect(describeDataTableEndpoint(baseConfig({ export: {} })).export).toEqual({ formats: { csv: 100_000 }, fields: ["id", "stadiumName", "status"] });
    expect(describeDataTableEndpoint(baseConfig({ export: undefined }))).not.toHaveProperty("export");
  });
});

describe("export — route", () => {
  it("streams CSV from a single snapshot (REPEATABLE READ, read only); headers and body are correct", async () => {
    const { db, calls, events } = source();
    const onExport = vi.fn();
    const server = await app(baseConfig({ export: { onExport } }), db);
    const res = await runExport(server, body());

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["x-datatablex-total"]).toBe("3");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="ge_i_ler.csv"; filename*=UTF-8''${encodeURIComponent("geçişler.csv")}`);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toBe(
      '﻿"No","Stadium","Status"\r\n' +
        '"1","Ali Sami Yen","open"\r\n' +
        '"2","\'=HYPERLINK(""x"")","closed"\r\n' +
        '"3","Şükrü Saracoğlu","open"\r\n',
    );

    expect(events).toEqual(["begin:repeatable read:read only", "stream-closed", "commit"]);
    // [0] is the COUNT at ticket time (no snapshot); [1] is the COUNT in the transaction, [2] the stream. `set local`
    // (the statement_timeout of the default `maxDurationMs`) is not a query and is not counted.
    const queries = calls.filter((q) => !q.sql.startsWith("set local"));
    const streamSql = queries[2]!.sql;
    expect(queries[0]!.sql).toMatch(/count\(\*\)/);
    expect(queries[1]!.sql).toMatch(/count\(\*\)/);
    expect(streamSql).toMatch(/order by "stadium_name" asc, "id" asc/);
    expect(streamSql).not.toMatch(/limit|offset/);
    expect(streamSql).not.toMatch(/nationalId/);
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport.mock.calls[0]![0]).toMatchObject({ outcome: "completed", rowCount: 3, total: 3, fields: ["id", "stadiumName", "status"] });
  });

  it("the formatter formats the cell on the server", async () => {
    const formatter = (field: string, value: unknown) => (field === "status" ? (value === "open" ? "Open" : "Closed") : value);
    const server = await app(baseConfig({ export: { formatter } }));
    const res = await runExport(server, body());
    expect(res.body).toContain('"1","Ali Sami Yen","Open"');
  });

  it("404 when export is not configured", async () => {
    const server = await app(baseConfig({ export: undefined }));
    const res = await runExport(server, body());
    expect(res.statusCode).toBe(404);
  });

  it("authorize and export.authorize are separate gates", async () => {
    const server = await app(baseConfig({ export: { authorize: (ctx) => ctx.roles.includes("access_logs:export") } }));
    const noRead = await runExport(server, body(), { "x-roles": "other" });
    expect(noRead.statusCode).toBe(403);
    const noExport = await runExport(server, body());
    expect(noExport.statusCode).toBe(403);
    expect(noExport.json().message).toBe("Not authorized to export");
    const ok = await runExport(server, body(), { "x-roles": "access_logs:read,access_logs:export" });
    expect(ok.statusCode).toBe(200);
  });

  it("a column not open to export, an invalid query and an unknown format get 400", async () => {
    const server = await app(baseConfig({ export: { fields: ["id", "stadiumName"] } }));
    const hidden = await runExport(server, body());
    expect(hidden.statusCode).toBe(400);
    expect(hidden.json().details[0].path).toEqual(["columns", 2, "field"]);

    const sensitive = await runExport(server, body({ columns: [{ field: "nationalId", title: "National ID" }] }));
    expect(sensitive.statusCode).toBe(400);

    const badQuery = await runExport(server, body({ query: { sorting: [], filters: null, search: "x".repeat(201) } }));
    expect(badQuery.statusCode).toBe(400);
    // A column problem and a query problem come back together in a single 400.
    expect(badQuery.json().details.map((d: { path: unknown[] }) => d.path)).toContainEqual(["query", "search"]);

    const xlsx = await runExport(server, body({ format: "xlsx" }));
    expect(xlsx.statusCode).toBe(400);
  });

  it("no ticket is issued when maxRows is exceeded (early 413); no transaction is opened", async () => {
    const { db, calls, events } = source(rows, 5000);
    const onExport = vi.fn();
    const server = await app(baseConfig({ export: { maxRows: 1000, onExport } }), db);
    const res = await runExport(server, body());
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: "Export Too Large", total: 5000, maxRows: 1000 });
    expect(calls).toHaveLength(1);
    expect(events).toEqual([]);
    expect(onExport).not.toHaveBeenCalled();
  });

  it("if the table grows between the ticket and the download, the download returns 413; the transaction is rolled back", async () => {
    let total = 10;
    const { db, events } = fakeExecutableDb((q) => (/count\(\*\)/.test(q.sql) ? [{ total: String(total) }] : []), { stream: () => rows });
    const server = await app(baseConfig({ export: { maxRows: 1000 } }), db);
    const issued = await server.inject({ method: "POST", url: "/q/export/ticket", payload: body() });
    expect(issued.statusCode).toBe(200);
    total = 5000;
    const res = await server.inject({ method: "GET", url: `/q/export/download?ticket=${issued.json().ticket}` });
    expect(res.statusCode).toBe(413);
    expect(events).toEqual(["begin:repeatable read:read only", "rollback"]);
  });
  it("a dialect without cursors returns an explicit 500; the transaction is rolled back and the event is 'failed'", async () => {
    const { db, events } = fakeExecutableDb((q) => (/count\(\*\)/.test(q.sql) ? [{ total: "3" }] : []));
    const onExport = vi.fn();
    const server = await app(baseConfig({ export: { onExport } }), db);
    const res = await runExport(server, body());
    expect(res.statusCode).toBe(500);
    expect(events).toEqual(["begin:repeatable read:read only", "rollback"]);
    expect(onExport.mock.calls[0]![0]).toMatchObject({ outcome: "failed" });
    expect((onExport.mock.calls[0]![0] as DataTableExportEvent).error).toMatchObject({ name: "ExportStreamingUnavailableError" });
  });

  it("statementTimeoutMs is applied with SET LOCAL in the export transaction", async () => {
    const { db, calls } = source();
    const server = await app(baseConfig({ export: { statementTimeoutMs: 5000 } }), db);
    await runExport(server, body());
    expect(calls[1]!.sql).toBe("set local statement_timeout = 5000");
  });

  it("filters and search apply the same WHERE to the COUNT and the stream; the client's pagination is ignored", async () => {
    const { db, calls } = source();
    const server = await app(baseConfig(), db);
    await runExport(
      server,
      body({
        query: {
          sorting: [],
          filters: { operator: "AND", filters: [{ field: "status", operator: "eq", value: "open" }] },
          search: "sami",
          pagination: { page: 9, pageSize: 1 },
        },
      }),
    );
    const where = (sql: string) => sql.slice(sql.indexOf("where"), sql.includes("order by") ? sql.indexOf("order by") : undefined).trim();
    // [0] is the COUNT at ticket time; [1] and [2] are the COUNT and the stream in the export transaction (excluding `set local`).
    const queries = calls.filter((q) => !q.sql.startsWith("set local"));
    expect(where(queries[1]!.sql)).toBe(where(queries[2]!.sql));
    expect(queries[2]!.sql).not.toMatch(/offset/);
  });
});

describe("openDataTableExport — cancellation", () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, stadiumName: `Stadium number ${i + 1} — a long name`, status: "open" }));

  it("if reading is abandoned midway, the cursor closes, the transaction is rolled back and the event is 'cancelled'", async () => {
    const { db, events } = source(many);
    const onExport = vi.fn();
    const config = baseConfig({ export: { onExport, batchSize: 100 } });
    const request = validateDataTableExportRequest(body(), config);
    const opened = await openDataTableExport(db, config, request, { userId: "u1", roles: [] });

    // Leaving the for-await after two chunks destroys the stream.
    let chunks = 0;
    for await (const chunk of opened.body) {
      expect(String(chunk).length).toBeGreaterThan(0);
      if (++chunks === 2) break;
    }
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["begin:repeatable read:read only", "stream-closed", "rollback"]);
    expect(onExport.mock.calls[0]![0].outcome).toBe("cancelled");
    expect(onExport.mock.calls[0]![0].rowCount).toBeLessThan(many.length);
  });

  it("the transaction also closes if the body is destroyed without ever being read", async () => {
    const { db, events } = source(many);
    const onExport = vi.fn();
    const config = baseConfig({ export: { onExport } });
    const opened = await openDataTableExport(db, config, validateDataTableExportRequest(body(), config), { userId: "u1", roles: [] });
    opened.body.destroy();
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["begin:repeatable read:read only", "stream-closed", "rollback"]);
    expect(onExport.mock.calls[0]![0]).toMatchObject({ outcome: "cancelled", rowCount: 0 });
  });

  it("if onExport throws, the stream is unaffected; the error is passed to the hook", async () => {
    const { db } = source();
    const onHookError = vi.fn();
    const config = baseConfig({ export: { onExport: () => { throw new Error("audit down"); } } });
    const opened = await openDataTableExport(db, config, validateDataTableExportRequest(body(), config), { userId: "u1", roles: [] }, { onHookError });
    let text = "";
    for await (const chunk of opened.body) text += String(chunk);
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(4);
    await vi.waitFor(() => expect(onHookError).toHaveBeenCalledTimes(1));
  });
});
