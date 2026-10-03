import { describe, expect, it } from "vitest";
import type { ComparisonOperator, Filter, ScalarOperator, TextOperator } from "../index.js";

/**
 * A compile-time contract: `pnpm typecheck` fails if any `@ts-expect-error`
 * line in this file stops producing an error (that is, if the type loosens).
 */
describe("Filter union", () => {
  it("text operators take only a string value", () => {
    const ok: Filter[] = [
      { field: "name", operator: "contains", value: "ali" },
      { field: "name", operator: "notStartsWith", value: "" },
    ];
    // @ts-expect-error contains expects a string; the backend rejects a number or boolean value with 400
    const bad: Filter = { field: "name", operator: "contains", value: true };
    // @ts-expect-error endsWith expects a string
    const badNumber: Filter = { field: "name", operator: "endsWith", value: 5 };
    expect(ok).toHaveLength(2);
    expect([bad, badNumber]).toHaveLength(2);
  });

  it("comparison operators take a string, a number and a boolean", () => {
    const filters: Filter[] = [
      { field: "price", operator: "gte", value: 10 },
      { field: "active", operator: "eq", value: true },
      { field: "name", operator: "neq", value: "x" },
    ];
    expect(filters).toHaveLength(3);
  });

  it("ScalarOperator is the union of the two groups", () => {
    const text: TextOperator = "contains";
    const comparison: ComparisonOperator = "gt";
    const scalars: ScalarOperator[] = [text, comparison];
    expect(scalars).toHaveLength(2);
  });
});
