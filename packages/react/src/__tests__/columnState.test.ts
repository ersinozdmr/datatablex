import { afterEach, describe, expect, it } from "vitest";
import {
  clearColumnStateRecord,
  defaultColumnState,
  normalizeColumnState,
  readColumnStateRecord,
  writeColumnStateRecord,
} from "../state/columnState.js";
import type { ReactDataTableColumn } from "../types.js";

interface Row {
  id: number;
  name: string;
  age: number;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "id", title: "ID" },
  { key: "name", title: "Name", defaultHidden: true },
  { key: "age", title: "Age", width: 120 },
];

describe("defaultColumnState", () => {
  it("turns the array index into order, defaultHidden into hidden and column.width into width", () => {
    expect(defaultColumnState(columns)).toEqual([
      { key: "id", hidden: false, width: undefined, order: 0, wrap: true },
      { key: "name", hidden: true, width: undefined, order: 1, wrap: true },
      { key: "age", hidden: false, width: 120, order: 2, wrap: true },
    ]);
  });
});

describe("normalizeColumnState", () => {
  it("falls back to the default when raw is not an array (null/malformed)", () => {
    expect(normalizeColumnState(null, columns)).toEqual(defaultColumnState(columns));
    expect(normalizeColumnState("garbage", columns)).toEqual(defaultColumnState(columns));
    expect(normalizeColumnState(undefined, columns)).toEqual(defaultColumnState(columns));
  });

  it("a key that is not in columns is dropped", () => {
    const raw = [
      { key: "id", order: 0 },
      { key: "ghost", order: 1 },
      { key: "name", order: 2 },
      { key: "age", order: 3 },
    ];
    const result = normalizeColumnState(raw, columns);
    expect(result.map((c) => c.key)).toEqual(["id", "name", "age"]);
  });

  it("when the same key appears more than once only the FIRST occurrence counts", () => {
    const raw = [
      { key: "id", order: 0, width: 50 },
      { key: "id", order: 5, width: 999 },
      { key: "name", order: 1 },
      { key: "age", order: 2 },
    ];
    const result = normalizeColumnState(raw, columns);
    const idState = result.find((c) => c.key === "id")!;
    expect(idState.width).toBe(50);
  });

  it("when order is not a finite integer (NaN/Infinity/fractional) that column goes to the end, ordered by array index", () => {
    const raw = [
      { key: "id", order: Number.NaN },
      { key: "name", order: 1.5 },
      { key: "age", order: 0 },
    ];
    const result = normalizeColumnState(raw, columns);
    // age carries a valid order=0 → it comes first; id/name are treated as
    // unrecorded and are appended AFTER it in their own array-index order (id=0, name=1).
    expect(result.map((c) => c.key)).toEqual(["age", "id", "name"]);
  });

  it("when width is not finite and positive (negative/0/NaN/Infinity) it falls back to column.width", () => {
    for (const badWidth of [-10, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const raw = [{ key: "age", order: 0, width: badWidth }];
      const result = normalizeColumnState(raw, columns);
      expect(result.find((c) => c.key === "age")!.width).toBe(120); // column.width fallback
    }
  });

  it("a valid width uses the value in the record", () => {
    const raw = [{ key: "age", order: 0, width: 300 }];
    const result = normalizeColumnState(raw, columns);
    expect(result.find((c) => c.key === "age")!.width).toBe(300);
  });

  it("hidden uses the value in the record, otherwise falls back to defaultHidden", () => {
    const raw = [{ key: "name", order: 0, hidden: false }];
    const result = normalizeColumnState(raw, columns);
    expect(result.find((c) => c.key === "name")!.hidden).toBe(false); // the record OVERRIDES defaultHidden: true

    const withoutRecord = normalizeColumnState([{ key: "id", order: 0 }], columns);
    expect(withoutRecord.find((c) => c.key === "name")!.hidden).toBe(true); // no record → defaultHidden
  });

  it("wrap uses the value in the record, otherwise falls back to true", () => {
    const raw = [{ key: "age", order: 0, wrap: false }];
    const result = normalizeColumnState(raw, columns);
    expect(result.find((c) => c.key === "age")!.wrap).toBe(false);
    expect(result.find((c) => c.key === "id")!.wrap).toBe(true); // no record → default
  });

  it("when wrap is not a boolean (string/number) it falls back to true", () => {
    const raw = [{ key: "age", order: 0, wrap: "false" }];
    const result = normalizeColumnState(raw, columns);
    expect(result.find((c) => c.key === "age")!.wrap).toBe(true);
  });

  it("columns that are in columns but not in the record are appended at the END in default order", () => {
    const raw = [{ key: "age", order: 0 }];
    const result = normalizeColumnState(raw, columns);
    expect(result.map((c) => c.key)).toEqual(["age", "id", "name"]);
  });

  it("the output always has exactly the length of columns and order is reassigned as 0..n-1", () => {
    const raw = [
      { key: "age", order: 100 },
      { key: "id", order: 50 },
    ];
    const result = normalizeColumnState(raw, columns);
    expect(result).toHaveLength(columns.length);
    expect(result.map((c) => c.order)).toEqual([0, 1, 2]);
  });

  it("an entry in the record that is not an object (string/number/null) is ignored and the hook does not crash", () => {
    const raw = ["garbage", 42, null, { key: "id", order: 0 }];
    expect(() => normalizeColumnState(raw, columns)).not.toThrow();
    const result = normalizeColumnState(raw, columns);
    expect(result.map((c) => c.key)).toEqual(["id", "name", "age"]);
  });

  /**
   * "At least one visible column" is enforced in the panel UI and also in the
   * normalization itself: a hand-edited or old localStorage record, or the
   * public `setColumnState`, could otherwise leave every column hidden.
   */
  it("when the record hides ALL columns the FIRST column is forced visible", () => {
    const raw = [
      { key: "id", order: 0, hidden: true },
      { key: "name", order: 1, hidden: true },
      { key: "age", order: 2, hidden: true },
    ];
    const result = normalizeColumnState(raw, columns);
    expect(result.map((c) => c.hidden)).toEqual([false, true, true]);
  });

  it("when ALL columns carry defaultHidden: true the FIRST column stays visible even without a record", () => {
    const allHiddenColumns: ReactDataTableColumn<Row>[] = columns.map((c) => ({ ...c, defaultHidden: true }));
    const result = normalizeColumnState(null, allHiddenColumns);
    expect(result.map((c) => c.hidden)).toEqual([false, true, true]);
  });
});

describe("localStorage persistence", () => {
  const TABLE_ID = "test-table";

  afterEach(() => {
    window.localStorage.clear();
  });

  it("write → read round trip works with the same schemaVersion", () => {
    const state = defaultColumnState(columns);
    writeColumnStateRecord(TABLE_ID, 1, state);
    expect(readColumnStateRecord(TABLE_ID, 1)).toEqual(state);
  });

  it("when schemaVersion does not match the record is discarded entirely (returns null)", () => {
    writeColumnStateRecord(TABLE_ID, 1, defaultColumnState(columns));
    expect(readColumnStateRecord(TABLE_ID, 2)).toBeNull();
  });

  it("malformed JSON is ignored through try/catch", () => {
    window.localStorage.setItem("datatablex:columns:" + TABLE_ID, "{not json");
    expect(readColumnStateRecord(TABLE_ID, 1)).toBeNull();
  });

  it("returns null when there is no record at all", () => {
    window.localStorage.removeItem("datatablex:columns:" + TABLE_ID);
    expect(readColumnStateRecord(TABLE_ID, 1)).toBeNull();
  });

  it("clearColumnStateRecord deletes the record", () => {
    writeColumnStateRecord(TABLE_ID, 1, defaultColumnState(columns));
    clearColumnStateRecord(TABLE_ID);
    expect(readColumnStateRecord(TABLE_ID, 1)).toBeNull();
  });

  it("different tableIds use keys ISOLATED from one another", () => {
    writeColumnStateRecord("table-a", 1, [{ key: "id", order: 0 }]);
    writeColumnStateRecord("table-b", 1, [{ key: "name", order: 0 }]);
    expect(readColumnStateRecord("table-a", 1)).toEqual([{ key: "id", order: 0 }]);
    expect(readColumnStateRecord("table-b", 1)).toEqual([{ key: "name", order: 0 }]);
  });
});
