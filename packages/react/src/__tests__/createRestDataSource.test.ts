import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataTableQuery } from "@datatablex/core";
import { createRestDataSource } from "../query/createRestDataSource.js";

function baseQuery(overrides: Partial<DataTableQuery> = {}): DataTableQuery {
  return { pagination: { page: 1, pageSize: 20 }, sorting: [], filters: null, ...overrides };
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRestDataSource", () => {
  it("the POST body is the raw DataTableQuery and the content type is application/json", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [], pagination: { page: 1, pageSize: 20, total: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    const source = createRestDataSource({ endpoint: "/api/access-logs/query" });
    await source.fetch(baseQuery());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/access-logs/query");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json", "x-datatablex-protocol": "1" });
    expect(JSON.parse(init.body as string)).toEqual(baseQuery());
  });

  it("static headers are merged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [], pagination: { page: 1, pageSize: 20, total: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    const source = createRestDataSource({ endpoint: "/q", headers: { authorization: "Bearer abc" } });
    await source.fetch(baseQuery());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer abc", "content-type": "application/json" });
  });

  it("function-style headers are called again on EVERY request (token refresh scenario)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [], pagination: { page: 1, pageSize: 20, total: 0 } }));
    vi.stubGlobal("fetch", fetchMock);
    let callCount = 0;
    const headersFn = vi.fn(() => ({ authorization: `Bearer token-${++callCount}` }));

    const source = createRestDataSource({ endpoint: "/q", headers: headersFn });
    await source.fetch(baseQuery());
    await source.fetch(baseQuery());

    expect(headersFn).toHaveBeenCalledTimes(2);
    const secondInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(secondInit.headers).toMatchObject({ authorization: "Bearer token-2" });
  });

  it("async headers fonksiyonu beklenir", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [], pagination: { page: 1, pageSize: 20, total: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    const source = createRestDataSource({ endpoint: "/q", headers: () => Promise.resolve({ authorization: "Bearer async" }) });
    await source.fetch(baseQuery());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer async" });
  });

  it("AbortSignal is passed to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [], pagination: { page: 1, pageSize: 20, total: 0 } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const source = createRestDataSource({ endpoint: "/q" });
    await source.fetch(baseQuery(), { signal: controller.signal });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("a successful response is returned as a DataTableResult", async () => {
    const payload = { data: [{ id: 1 }], pagination: { page: 1, pageSize: 20, total: 1 } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    const source = createRestDataSource<{ id: number }>({ endpoint: "/q" });
    const result = await source.fetch(baseQuery());
    expect(result).toEqual(payload);
  });

  it.each([
    ["HTML error page (not JSON)", undefined],
    ["data is not an array", { data: {}, pagination: { page: 1, pageSize: 20, total: 0 } }],
    ["pagination yok", { data: [] }],
    ["pageSize is zero", { data: [], pagination: { page: 1, pageSize: 0, total: 0 } }],
    ["page kesirli", { data: [], pagination: { page: 1.5, pageSize: 20, total: 0 } }],
    ["total negatif", { data: [], pagination: { page: 1, pageSize: 20, total: -1 } }],
    ["total string", { data: [], pagination: { page: 1, pageSize: 20, total: "10" } }],
  ])("a 2xx with a malformed envelope is rejected: %s", async (_label, body) => {
    const response = body === undefined ? ({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token <")) } as Response) : jsonResponse(body);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const source = createRestDataSource({ endpoint: "/q" });
    await expect(source.fetch(baseQuery())).rejects.toThrow(/\/q did not return a valid DataTableResult/);
  });

  it("total: null in a skipCount response is valid", async () => {
    const payload = { data: [], pagination: { page: 3, pageSize: 20, total: null } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));
    await expect(createRestDataSource({ endpoint: "/q" }).fetch(baseQuery())).resolves.toEqual(payload);
  });

  it("when !res.ok and the backend sends an {error} body, the message is taken from it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Forbidden" }, { ok: false, status: 403 })));

    const source = createRestDataSource({ endpoint: "/q" });
    await expect(source.fetch(baseQuery())).rejects.toThrow("Forbidden");
  });

  it("the ACTUAL message of Fastify's {statusCode,error,message} body is surfaced", async () => {
    // `error` here is the HTTP status text; reading it would hide the real reason.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ statusCode: 400, error: "Bad Request", message: "This endpoint has no searchable fields" }, { ok: false, status: 400 }),
      ),
    );

    const source = createRestDataSource({ endpoint: "/q" });
    await expect(source.fetch(baseQuery())).rejects.toThrow("This endpoint has no searchable fields");
    // The status code is carried too, so `<DataTable>` can tell a 4xx from a 5xx.
    await expect(source.fetch(baseQuery())).rejects.toMatchObject({ name: "DataTableRequestError", status: 400 });
  });

  it("when !res.ok and the body is not JSON, it fails with the HTTP status code", async () => {
    const res = {
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));

    const source = createRestDataSource({ endpoint: "/q" });
    await expect(source.fetch(baseQuery())).rejects.toThrow("500");
  });

  it("AbortError is rethrown as it is — neither swallowed nor wrapped", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(abortError)),
    );

    const source = createRestDataSource({ endpoint: "/q" });
    await expect(source.fetch(baseQuery())).rejects.toBe(abortError);
  });
});

describe("createRestDataSource — getMeta", () => {
  const meta = {
    version: 1,
    protocol: { version: 1, supported: [1] },
    primaryKey: "id",
    limits: { maxPageSize: 500, maxFilterDepth: 3, maxFilterCount: 50, maxInValues: 500, maxSearchLength: 200, maxSortCount: 3, maxOffset: null },
    fields: { id: { type: "number", filterOperators: ["in"], sortable: false, searchable: false } },
  };

  it("getMeta is undefined when metaEndpoint is not given", () => {
    expect(createRestDataSource({ endpoint: "/q" }).getMeta).toBeUndefined();
  });

  it("sends a GET with headers to metaEndpoint and returns the validated meta", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(meta));
    vi.stubGlobal("fetch", fetchMock);

    const source = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta", headers: () => ({ authorization: "Bearer t" }) });
    await expect(source.getMeta!()).resolves.toEqual(meta);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/q/meta");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ "x-datatablex-protocol": "1", authorization: "Bearer t" });
  });

  it("!res.ok → DataTableRequestError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Forbidden", message: "Forbidden" }, { ok: false, status: 403 })));
    const source = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta" });
    await expect(source.getMeta!()).rejects.toMatchObject({ name: "DataTableRequestError", status: 403 });
  });

  it("an unknown version or a malformed body is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...meta, version: 2 })));
    const source = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta" });
    await expect(source.getMeta!()).rejects.toThrow(/recognized metadata definition/);
  });
});

describe("createRestDataSource — meta cache", () => {
  const metaBody = {
    version: 1,
    protocol: { version: 1, supported: [1] },
    primaryKey: "id",
    limits: { maxPageSize: 500, maxFilterDepth: 3, maxFilterCount: 50, maxInValues: 500, maxSearchLength: 200, maxSortCount: 3, maxOffset: null },
    fields: {},
  };

  it("meta is fetched once per instance; the second call returns from the cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(metaBody));
    vi.stubGlobal("fetch", fetchMock);
    const source = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta" });
    await source.getMeta!();
    await source.getMeta!();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed request is not cached; invalidateMeta empties the cache", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "down" }, { ok: false, status: 503 }))
      .mockResolvedValue(jsonResponse(metaBody));
    vi.stubGlobal("fetch", fetchMock);
    const source = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta" });
    await expect(source.getMeta!()).rejects.toThrow("down");
    await source.getMeta!();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    source.invalidateMeta!();
    await source.getMeta!();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("one caller's cancellation does not cut the shared request", async () => {
    let release!: () => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (release = () => resolve(jsonResponse(metaBody)))));
    vi.stubGlobal("fetch", fetchMock);
    const source = createRestDataSource({ endpoint: "/q", metaEndpoint: "/q/meta" });
    const controller = new AbortController();
    const cancelled = source.getMeta!({ signal: controller.signal });
    const other = source.getMeta!();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release();
    await expect(other).resolves.toMatchObject({ primaryKey: "id" });
  });
});

