import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { isDataTableFieldOptions } from "@datatablex/core";
import { datatableRoute } from "../datatableRoute.js";
import type { BaseCtx, DataTableEndpointConfig, FieldConfig } from "../types.js";
import type { TestDB } from "./kyselyTestUtils.js";
import { fakeExecutableDb } from "./kyselyTestUtils.js";

type Config = DataTableEndpointConfig<TestDB, "access_logs">;
type Field = FieldConfig<TestDB, "access_logs">;

const STATUSES = [
  { label: "Open", value: "open" },
  { label: "Closed", value: "closed" },
];

function baseConfig(status: Partial<Field> = {}, overrides: Partial<Config> = {}): Config {
  return {
    table: "access_logs",
    primaryKey: "id",
    fields: {
      id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
      stadiumName: { column: "stadium_name", type: "text", filterOperators: ["eq"] },
      status: { column: "status", type: "enum", filterOperators: ["in", "notIn"], options: STATUSES, ...status },
    },
    getContext: (req) => ({ userId: "u1", roles: ["read"], tenantId: String(req.headers["x-tenant"] ?? "t1") }),
    authorize: (ctx) => ctx.roles.includes("read"),
    ...overrides,
  };
}

async function app(config: Config) {
  const server = Fastify();
  const handler = datatableRoute(fakeExecutableDb(() => []).db, config);
  server.get("/q/meta", handler.meta);
  server.get("/q/options/:field", handler.options);
  await server.ready();
  return server;
}

describe("FieldConfig.options — boot-time validation", () => {
  const { db } = fakeExecutableDb(() => []);
  const boot = (status: Partial<Field>, overrides: Partial<Config> = {}) => () => datatableRoute(db, baseConfig(status, overrides));

  it("a static list and a resolver are valid", () => {
    expect(boot({})).not.toThrow();
    expect(boot({ options: () => STATUSES })).not.toThrow();
  });

  it("is rejected on a field that is not type: \"enum\"", () => {
    expect(boot({ type: "text" })).toThrow(/only on a type: "enum" field/);
  });

  it("is rejected unless in/notIn is enabled", () => {
    expect(boot({ filterOperators: ["eq"] })).toThrow(/do not include "in" or "notIn"/);
    expect(boot({ filterOperators: undefined })).toThrow(/do not include "in" or "notIn"/);
  });

  it("a sensitive field and an alias of a sensitive column cannot offer options", () => {
    expect(
      boot({}, { fields: { ...baseConfig().fields, nationalId: { column: "nationalId", type: "enum", sensitive: true, filterOperators: ["eq"], options: STATUSES } } }),
    ).toThrow(/allows only the operators|cannot offer options|do not include "in" or "notIn"/);
    expect(
      boot(
        {},
        {
          fields: {
            ...baseConfig().fields,
            nationalId: { column: "nationalId", type: "text", sensitive: true, filterOperators: ["eq"] },
            nationalIdAlias: { column: "nationalId", type: "enum", declassify: true, filterOperators: ["eq"], options: STATUSES },
          },
        },
      ),
    ).toThrow(/cannot offer options/);
  });

  it("the shape and length of a static list are validated at boot", () => {
    expect(boot({ options: [{ label: "x" }] as never })).toThrow(/item 0 is not of the form/);
    expect(boot({ options: [{ label: "x", value: true }] as never })).toThrow(/item 0 is not of the form/);
    expect(boot({ options: "open" as never })).toThrow(/must be an array/);
    expect(boot({ maxOptions: 1 })).toThrow(/contain 2 items; maxOptions is 1/);
  });

  it.each([0, -1, 1.5, Number.NaN])("an invalid maxOptions (%s) stops boot", (maxOptions) => {
    expect(boot({ maxOptions })).toThrow(/maxOptions of field "status" must be a positive/);
  });
});

describe("datatableRoute — options handler", () => {
  it("meta reports hasOptions only on a field that defines options and does not carry the list", async () => {
    const res = await (await app(baseConfig())).inject({ method: "GET", url: "/q/meta" });
    const { fields } = res.json();
    expect(fields.status).toEqual({ type: "enum", filterOperators: ["in", "notIn"], sortable: false, searchable: false, hasOptions: true });
    expect(fields.stadiumName).not.toHaveProperty("hasOptions");
    expect(res.body).not.toContain("Closed");
  });

  it("returns the static list with a versioned body and no-store", async () => {
    const res = await (await app(baseConfig())).inject({ method: "GET", url: "/q/options/status" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ version: 1, options: STATUSES });
    expect(isDataTableFieldOptions(res.json())).toBe(true);
  });

  it("the resolver is called with ctx on every request; the result is not shared between users", async () => {
    const options = vi.fn(async (ctx: BaseCtx) => [{ label: `Status ${ctx.tenantId}`, value: 1, internal: "x" }]);
    const server = await app(baseConfig({ options }));
    const first = await server.inject({ method: "GET", url: "/q/options/status", headers: { "x-tenant": "a" } });
    const second = await server.inject({ method: "GET", url: "/q/options/status", headers: { "x-tenant": "b" } });
    // The extra field (`internal`) is not carried to the response.
    expect(first.json().options).toEqual([{ label: "Status a", value: 1 }]);
    expect(second.json().options).toEqual([{ label: "Status b", value: 1 }]);
    expect(options).toHaveBeenCalledTimes(2);
  });

  it.each(["ghost", "stadiumName", "constructor"])("an unknown field or a field without options (%s) -> 400 field_not_allowed", async (field) => {
    const res = await (await app(baseConfig())).inject({ method: "GET", url: `/q/options/${field}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("field_not_allowed");
  });

  it("authorize false -> 403; the resolver is not called", async () => {
    const options = vi.fn(() => STATUSES);
    const res = await (await app(baseConfig({ options }, { authorize: () => false }))).inject({ method: "GET", url: "/q/options/status" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    expect(options).not.toHaveBeenCalled();
  });

  it("an unsupported protocol -> 400", async () => {
    const res = await (await app(baseConfig())).inject({ method: "GET", url: "/q/options/status", headers: { "x-datatablex-protocol": "99" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("unsupported_protocol");
  });

  it("when maxOptions is exceeded it does not truncate: 500 options_too_large, no detail in the body", async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ label: `secret-${i}`, value: i }));
    const res = await (await app(baseConfig({ options: () => many, maxOptions: 2 }))).inject({ method: "GET", url: "/q/options/status" });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe("options_too_large");
    expect(res.body).not.toContain("secret");
    expect(res.json().message).toBe("The option list exceeds the server limit.");
  });

  it("the default ceiling is 500", async () => {
    const list = (length: number) => () => Array.from({ length }, (_, i) => ({ label: String(i), value: i }));
    expect((await (await app(baseConfig({ options: list(500) }))).inject({ method: "GET", url: "/q/options/status" })).statusCode).toBe(200);
    expect((await (await app(baseConfig({ options: list(501) }))).inject({ method: "GET", url: "/q/options/status" })).json().code).toBe("options_too_large");
  });

  it("when the resolver throws or returns a malformed list, a sanitized 500 internal_error is returned", async () => {
    const thrown = await (
      await app(
        baseConfig({
          options: () => {
            throw new Error("db password: hunter2");
          },
        }),
      )
    ).inject({ method: "GET", url: "/q/options/status" });
    expect(thrown.statusCode).toBe(500);
    expect(thrown.json().code).toBe("internal_error");
    expect(thrown.body).not.toContain("hunter2");

    const malformed = await (await app(baseConfig({ options: (() => [{ label: 1, value: "x" }]) as never }))).inject({ method: "GET", url: "/q/options/status" });
    expect(malformed.statusCode).toBe(500);
    expect(malformed.json().code).toBe("internal_error");
  });
});
