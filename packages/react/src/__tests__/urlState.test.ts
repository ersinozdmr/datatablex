import { describe, expect, it } from "vitest";
import { encodeFilterParam } from "@datatablex/core";
import type { FilterGroup } from "@datatablex/core";
import { readUrlState, urlStateEqual, writeUrlState } from "../state/urlState.js";
import type { UrlQueryState, UrlStateOptions } from "../state/urlState.js";

const options: UrlStateOptions = {
  defaultPageSize: 20,
  maxPageSize: 500,
  maxSearchLength: 10,
  sortableFields: new Set(["accessDate", "price"]),
};

const empty: UrlQueryState = { page: 1, pageSize: 20, sorting: [], search: "", filters: null };

const tree: FilterGroup = {
  operator: "AND",
  filters: [
    { field: "stadiumName", operator: "notContains", value: "Park" },
    { operator: "OR", filters: [{ field: "status", operator: "in", value: ["closed"] }, { field: "price", operator: "gte", value: 400 }] },
  ],
};

describe("readUrlState / writeUrlState", () => {
  it("a populated state survives a round trip", () => {
    const state: UrlQueryState = { page: 3, pageSize: 50, sorting: [{ field: "accessDate", direction: "desc" }], search: "Ağrı", filters: tree };
    const params = writeUrlState(new URLSearchParams(), state, options);
    expect(readUrlState(params, options)).toEqual(state);
  });

  it("a crafted deeply nested `f` parameter does not throw: the filter is ignored and the other parameters are read", () => {
    const deep = `{"operator":"AND","filters":[`.repeat(3_000) + `{"field":"a","operator":"eq","value":1}` + `]}`.repeat(3_000);
    const f = Buffer.from(`{"v":1,"filters":${deep}}`, "utf8").toString("base64url");
    const params = new URLSearchParams({ f, page: "3", search: "x" });
    expect(() => readUrlState(params, options)).not.toThrow();
    expect(readUrlState(params, options)).toEqual({ ...empty, page: 3, search: "x" });
  });

  it("defaults are not written; parameters are written in a fixed order", () => {
    expect(writeUrlState(new URLSearchParams(), empty, options).toString()).toBe("");
    const state: UrlQueryState = { ...empty, page: 2, sorting: [{ field: "price", direction: "asc" }], search: "x" };
    expect(writeUrlState(new URLSearchParams(), state, options).toString()).toBe("page=2&sort=price%3Aasc&search=x");
  });

  it("leaves other parameters alone and removes only its own keys", () => {
    const current = new URLSearchParams("tab=logs&page=4&search=old");
    expect(writeUrlState(current, empty, options).toString()).toBe("tab=logs");
  });

  it("a prefix separates the keys; it does not touch the parameters of an unprefixed table", () => {
    const prefixed = { ...options, prefix: "logs" };
    const params = writeUrlState(new URLSearchParams("page=7"), { ...empty, page: 2, filters: tree }, prefixed);
    expect(params.get("page")).toBe("7");
    expect(params.get("logs.page")).toBe("2");
    expect(readUrlState(params, prefixed)).toMatchObject({ page: 2, filters: tree });
    expect(readUrlState(params, options).page).toBe(7);
  });

  it("an invalid page/page size falls back to the default, the page size is clamped, the search is truncated", () => {
    expect(readUrlState(new URLSearchParams("page=0&pageSize=-3&search=çokuzunaramametni"), options)).toMatchObject({
      page: 1,
      pageSize: 20,
      search: "çokuzunara",
    });
    expect(readUrlState(new URLSearchParams("page=1e3&pageSize=9999"), options)).toMatchObject({ page: 1, pageSize: 500 });
  });

  it("a non-sortable field, a malformed direction and a repeated field are dropped", () => {
    const params = new URLSearchParams("sort=nationalId:asc,price:up,price:desc,accessDate:asc,price:asc");
    expect(readUrlState(params, options).sorting).toEqual([
      { field: "price", direction: "desc" },
      { field: "accessDate", direction: "asc" },
    ]);
  });

  it("a malformed f is ignored; a validly shaped tree with unknown fields is not pruned", () => {
    expect(readUrlState(new URLSearchParams("f=%%%&page=2"), options)).toMatchObject({ filters: null, page: 2 });
    const foreign: FilterGroup = { operator: "AND", filters: [{ field: "dashboardOnly", operator: "eq", value: 1 }] };
    expect(readUrlState(new URLSearchParams({ f: encodeFilterParam(foreign) }), options).filters).toEqual(foreign);
  });
});

describe("urlStateEqual", () => {
  it("filters with a different child order but the same meaning are equal", () => {
    const reordered: FilterGroup = { operator: "AND", filters: [tree.filters[1]!, tree.filters[0]!] };
    expect(urlStateEqual({ ...empty, filters: tree }, { ...empty, filters: reordered })).toBe(true);
  });

  it("they are not equal if any field differs", () => {
    expect(urlStateEqual(empty, { ...empty, page: 2 })).toBe(false);
    expect(urlStateEqual(empty, { ...empty, sorting: [{ field: "price", direction: "asc" }] })).toBe(false);
    expect(urlStateEqual({ ...empty, filters: tree }, empty)).toBe(false);
  });
});
