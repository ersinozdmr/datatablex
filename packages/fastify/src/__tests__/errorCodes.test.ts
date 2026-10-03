import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { isDataTableErrorBody } from "@datatablex/core";
import { datatableRoute } from "../datatableRoute.js";
import { DataTableInternalError } from "../errors.js";
import { createMemoryTicketStore } from "../ticket.js";
import type { DataTableEndpointConfig } from "../types.js";
import type { TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

type Config = DataTableEndpointConfig<TestDB, "access_logs">;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
      stadiumName: { column: "stadium_name", type: "text", filterOperators: ["eq"] },
    },
    getContext: (req) => ({ userId: "u1", roles: String(req.headers["x-roles"] ?? "read").split(",") }),
    authorize: (ctx) => ctx.roles.includes("read"),
    export: { authorize: (ctx) => ctx.roles.includes("export") },
    ...overrides,
  };
}

async function app(config: Config) {
  const server = Fastify();
  const handler = datatableRoute(fakeExecutableDb(() => [{ total: "0" }]).db, config);
  server.post("/q", handler);
  server.get("/q/meta", handler.meta);
  server.post("/q/export/ticket", handler.exportTicket);
  server.get("/q/export/download", handler.exportDownload);
  await server.ready();
  return server;
}

const query = (overrides: Record<string, unknown> = {}) => ({ pagination: { page: 1, pageSize: 10 }, sorting: [], filters: null, ...overrides });
const exportBody = { query: { sorting: [], filters: null }, format: "csv", columns: [{ field: "id", title: "No" }] };

/** Every error body has the `DataTableErrorBody` shape and carries the machine code. */
describe("error body contract — code", () => {
  it.each([
    ["unauthorized query", (s: Awaited<ReturnType<typeof app>>) => s.inject({ method: "POST", url: "/q", payload: query(), headers: { "x-roles": "other" } }), 403, "forbidden"],
    ["unauthorized meta", (s: Awaited<ReturnType<typeof app>>) => s.inject({ method: "GET", url: "/q/meta", headers: { "x-roles": "other" } }), 403, "forbidden"],
    ["invalid query (Zod)", (s: Awaited<ReturnType<typeof app>>) => s.inject({ method: "POST", url: "/q", payload: { nope: true } }), 400, "validation"],
    [
      "field outside the whitelist (through the Fastify default error handler)",
      (s: Awaited<ReturnType<typeof app>>) => s.inject({ method: "POST", url: "/q", payload: query({ sorting: [{ field: "ghost", direction: "asc" }] }) }),
      400,
      "field_not_allowed",
    ],
    [
      "unsupported protocol",
      (s: Awaited<ReturnType<typeof app>>) => s.inject({ method: "POST", url: "/q", payload: query(), headers: { "x-datatablex-protocol": "99" } }),
      400,
      "unsupported_protocol",
    ],
    ["no export permission", (s: Awaited<ReturnType<typeof app>>) => s.inject({ method: "POST", url: "/q/export/ticket", payload: exportBody }), 403, "export_forbidden"],
    ["invalid export request", (s: Awaited<ReturnType<typeof app>>) => s.inject({ method: "POST", url: "/q/export/ticket", payload: {}, headers: { "x-roles": "read,export" } }), 400, "validation"],
  ] as const)("%s", async (_name, send, status, code) => {
    const response = await send(await app(baseConfig()));
    expect(response.statusCode).toBe(status);
    const body = response.json();
    expect(isDataTableErrorBody(body)).toBe(true);
    expect(body.code).toBe(code);
  });

  it("a ticket request gets export_disabled when export is off", async () => {
    const response = await (await app(baseConfig({ export: undefined }))).inject({ method: "POST", url: "/q/export/ticket", payload: exportBody });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("export_disabled");
  });

  describe("unexpected error → 500 internal_error, no detail leaks", () => {
    const secret = 'relation "secret_audit_table" does not exist';
    const failingDb = () =>
      fakeExecutableDb(() => {
        throw new Error(secret);
      }).db;
    async function server(config: Config, db = fakeExecutableDb(() => [{ total: "0" }]).db) {
      const s = Fastify();
      const handler = datatableRoute(db, config);
      s.post("/q", handler);
      s.get("/q/meta", handler.meta);
      s.post("/q/export/ticket", handler.exportTicket);
      s.get("/q/export/download", handler.exportDownload);
      await s.ready();
      return s;
    }
    const expectInternal = (response: { statusCode: number; json: () => unknown; body: string }) => {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "internal_error", message: "The server could not process the request." });
      expect(response.body).not.toMatch(/secret_audit_table|scope|boolean|getContext blew up/);
    };

    it("InvalidScopeError (a deployment error) does not carry its message to the client", async () => {
      const s = await server(baseConfig({ scope: (() => "not-an-expression") as never }));
      expectInternal(await s.inject({ method: "POST", url: "/q", payload: query() }));
    });

    it("a database error does not leak in the query or in the ticket COUNT", async () => {
      const s = await server(baseConfig(), failingDb());
      expectInternal(await s.inject({ method: "POST", url: "/q", payload: query() }));
      expectInternal(await s.inject({ method: "POST", url: "/q/export/ticket", payload: exportBody, headers: { "x-roles": "read,export" } }));
    });

    it("a plain Error from getContext gives 500 internal_error; an error with a statusCode (401) passes through as is", async () => {
      const plain = await server(
        baseConfig({
          getContext: () => {
            throw new Error("getContext blew up");
          },
        }),
      );
      expectInternal(await plain.inject({ method: "GET", url: "/q/meta" }));
      const unauthorized = await server(
        baseConfig({
          getContext: () => {
            throw Object.assign(new Error("No session"), { statusCode: 401, code: "unauthenticated" });
          },
        }),
      );
      const response = await unauthorized.inject({ method: "POST", url: "/q", payload: query() });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ message: "No session", code: "unauthenticated" });
    });

    it("the original error reaches the application's setErrorHandler in cause", async () => {
      const s = Fastify();
      let seen: unknown;
      s.setErrorHandler((err, _req, reply) => {
        seen = err;
        return reply.code(500).send({ code: "internal_error", message: "x" });
      });
      s.post("/q", datatableRoute(failingDb(), baseConfig()));
      await s.ready();
      await s.inject({ method: "POST", url: "/q", payload: query() });
      expect(seen).toBeInstanceOf(DataTableInternalError);
      expect((seen as Error).cause).toMatchObject({ message: secret });
    });

    it("an unexpected error on the download route returns as an attachment and carries no detail", async () => {
      const store = createMemoryTicketStore();
      const s = await server(
        baseConfig({
          export: {
            ticketStore: {
              set: store.set,
              take: () => {
                throw new Error(secret);
              },
            },
          },
        }),
      );
      const response = await s.inject({ method: "GET", url: `/q/export/download?ticket=${"a".repeat(43)}` });
      expect(response.statusCode).toBe(500);
      expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="export-error\.txt"/);
      expect(response.body).toContain("The server could not process the request.");
      expect(response.body).not.toContain("secret_audit_table");
    });
  });

  it("413 export_too_large carries the total and the ceiling in the body", async () => {
    const server = Fastify();
    const handler = datatableRoute(fakeExecutableDb(() => [{ total: "5" }]).db, baseConfig({ export: { maxRows: 1 } }));
    server.post("/q/export/ticket", handler.exportTicket);
    await server.ready();
    const response = await server.inject({ method: "POST", url: "/q/export/ticket", payload: exportBody });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "export_too_large", total: 5, maxRows: 1 });
  });
});