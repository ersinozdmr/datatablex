import { describe, expect, it } from "vitest";
import { decodeFilterParam, encodeFilterParam } from "../filterParam.js";
import type { FilterGroup } from "../types.js";

const encodeRaw = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("encodeFilterParam / decodeFilterParam", () => {
  it("round-trips a nested OR tree and non-ASCII (Turkish) characters losslessly", () => {
    const tree: FilterGroup = {
      operator: "AND",
      filters: [
        { field: "stadiumName", operator: "notContains", value: "Ağrı Diğer İğdır" },
        { operator: "OR", filters: [{ field: "status", operator: "in", value: ["closed"] }, { field: "price", operator: "gte", value: 400 }] },
        { field: "deletedAt", operator: "isNull" },
      ],
    };
    const encoded = encodeFilterParam(tree);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFilterParam(encoded)).toEqual(tree);
  });

  it("produces base64url that needs no escaping in a URL", () => {
    const encoded = encodeFilterParam({ operator: "AND", filters: [{ field: "a", operator: "eq", value: "??>>~~" }] });
    expect(new URLSearchParams({ f: encoded }).toString()).toBe(`f=${encoded}`);
  });

  it("returns null for an unknown version, malformed base64, invalid UTF-8 and malformed JSON", () => {
    expect(decodeFilterParam(encodeRaw({ v: 2, filters: { operator: "AND", filters: [{ field: "a", operator: "isNull" }] } }))).toBeNull();
    expect(decodeFilterParam("%%%")).toBeNull();
    expect(decodeFilterParam("A")).toBeNull();
    expect(decodeFilterParam(Buffer.from([0xff, 0xfe]).toString("base64url"))).toBeNull();
    expect(decodeFilterParam(Buffer.from("{broken", "utf8").toString("base64url"))).toBeNull();
  });

  it("returns null for a tree that is not a FilterGroup shape or is empty", () => {
    expect(decodeFilterParam(encodeRaw({ v: 1, filters: { operator: "XOR", filters: [] } }))).toBeNull();
    expect(decodeFilterParam(encodeRaw({ v: 1, filters: { operator: "AND", filters: [{ field: "a", operator: "regex", value: "." }] } }))).toBeNull();
    expect(decodeFilterParam(encodeRaw({ v: 1, filters: { operator: "AND", filters: [] } }))).toBeNull();
    expect(decodeFilterParam(encodeRaw([1, 2]))).toBeNull();
  });

  describe("malicious URL", () => {
    const leaf = { field: "a", operator: "eq", value: 1 };
    /** AND groups nested `depth` levels deep; the JSON text is built by hand (JSON.stringify is recursive too). */
    const nestedJson = (depth: number) => `{"operator":"AND","filters":[`.repeat(depth) + JSON.stringify(leaf) + `]}`.repeat(depth);
    const nested = (depth: number) => JSON.parse(nestedJson(depth)) as unknown;
    const param = (filters: unknown) => encodeRaw({ v: 1, filters });
    const rawParam = (json: string) => Buffer.from(`{"v":1,"filters":${json}}`, "utf8").toString("base64url");

    it("a very deep tree does not throw: it returns null", () => {
      const deep = rawParam(nestedJson(3_000));
      expect(deep.length).toBeGreaterThan(32_768);
      expect(() => decodeFilterParam(deep, { maxLength: 10_000_000 })).not.toThrow();
      expect(decodeFilterParam(deep, { maxLength: 10_000_000 })).toBeNull();
      expect(decodeFilterParam(deep)).toBeNull(); // the default length limit cuts it off too
      // Even when the length limit is passed, the iterative validation stops at the depth limit.
      expect(decodeFilterParam(rawParam(nestedJson(1_500)), { maxLength: 10_000_000, maxNodes: 100_000 })).toBeNull();
    });

    it("depth limit: the default 16 passes, 17 is rejected; the limit is configurable", () => {
      expect(decodeFilterParam(param(nested(16)))).not.toBeNull();
      expect(decodeFilterParam(param(nested(17)))).toBeNull();
      expect(decodeFilterParam(param(nested(3)), { maxDepth: 2 })).toBeNull();
      expect(decodeFilterParam(param(nested(3)), { maxDepth: 3 })).not.toBeNull();
    });

    it("the node count and the number of in-values are limited", () => {
      const wide = { operator: "OR", filters: Array.from({ length: 600 }, () => leaf) };
      expect(decodeFilterParam(param(wide))).toBeNull();
      expect(decodeFilterParam(param({ operator: "OR", filters: Array.from({ length: 499 }, () => leaf) }))).not.toBeNull();
      const many = { operator: "AND", filters: [{ field: "a", operator: "in", value: Array.from({ length: 1_001 }, (_, i) => i) }] };
      expect(decodeFilterParam(param(many))).toBeNull();
      expect(decodeFilterParam(param(many), { maxInValues: 2_000 })).not.toBeNull();
    });

    it("encoded length limit", () => {
      expect(decodeFilterParam("A".repeat(40_000))).toBeNull();
    });

    it("poisoned nodes with `filters` on a leaf or `field`/`value` on a group are rejected", () => {
      expect(decodeFilterParam(param({ operator: "AND", filters: [{ ...leaf, filters: [] }] }))).toBeNull();
      expect(decodeFilterParam(param({ operator: "AND", filters: [{ operator: "OR", field: "a", filters: [leaf] }] }))).toBeNull();
      expect(decodeFilterParam(param({ operator: "AND", field: "a", filters: [leaf] }))).toBeNull();
    });

    it("the returned tree is canonical: extra fields are dropped and nothing is shared with the input object", () => {
      const decoded = decodeFilterParam(
        param({ operator: "AND", extra: 1, filters: [{ field: "a", operator: "isNull", value: 5 }, { field: "b", operator: "in", value: ["x"], junk: true }] }),
      );
      expect(decoded).toEqual({ operator: "AND", filters: [{ field: "a", operator: "isNull" }, { field: "b", operator: "in", value: ["x"] }] });
    });

    it("a text operator accepts only a string value", () => {
      expect(decodeFilterParam(param({ operator: "AND", filters: [{ field: "a", operator: "contains", value: 5 }] }))).toBeNull();
      expect(decodeFilterParam(param({ operator: "AND", filters: [{ field: "a", operator: "contains", value: "5" }] }))).not.toBeNull();
    });
  });
});
