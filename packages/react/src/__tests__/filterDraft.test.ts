import { describe, expect, it } from "vitest";
import type { FilterGroup } from "@datatablex/core";
import {
  duplicateNode,
  fromDraft,
  groupDepth,
  insertNode,
  newGroupNode,
  newRuleNode,
  removeNode,
  replaceNode,
  setGroupOperator,
  toDraft,
  validateDraft,
} from "../state/filterDraft.js";
import type { DraftGroup, DraftNode } from "../state/filterDraft.js";
import type { ReactDataTableColumn } from "../types.js";

interface Row {
  name: string;
  price: number;
  accessDate: string;
}

const columns: ReactDataTableColumn<Row>[] = [
  { key: "name", title: "Name", type: "text", filterable: true, filterOperators: ["contains", "notContains", "eq"] },
  { key: "price", title: "Price", type: "number", filterable: true, filterOperators: ["gt", "lt", "gte", "lte", "between"] },
  { key: "accessDate", title: "Time", type: "datetime", timezone: "Europe/Istanbul", filterable: true },
];

const onDay: FilterGroup = {
  operator: "AND",
  filters: [
    { field: "accessDate", operator: "gte", value: "2026-01-14T21:00:00.000Z" },
    { field: "accessDate", operator: "lt", value: "2026-01-15T21:00:00.000Z" },
  ],
};

/** Drops the ids so that only the structure is compared. */
function shape(node: DraftNode): unknown {
  if (node.type === "group") return { group: node.operator, children: node.children.map(shape) };
  return node.type === "rule" ? { rule: node.rule } : { external: node.node };
}

const limits = { maxRules: 50, maxDepth: 3 };

describe("toDraft / fromDraft", () => {
  it("a nested AND/OR tree survives a round trip unchanged; the datetime wrapper becomes a single rule", () => {
    const tree: FilterGroup = {
      operator: "OR",
      filters: [
        { operator: "AND", filters: [{ field: "name", operator: "notContains", value: "Park" }, { field: "price", operator: "gt", value: 400 }] },
        onDay,
      ],
    };
    const draft = toDraft(tree, columns);
    expect(shape(draft)).toEqual({
      group: "OR",
      children: [
        {
          group: "AND",
          children: [
            { rule: { field: "name", operator: "notContains", value: "Park" } },
            { rule: { field: "price", operator: "gt", value: 400 } },
          ],
        },
        { rule: { field: "accessDate", operator: "onDay", value: "2026-01-15" } },
      ],
    });
    expect(fromDraft(draft, columns)).toEqual(tree);
  });

  it("a leaf that cannot be resolved to a rule is kept as an external node", () => {
    const tree: FilterGroup = { operator: "AND", filters: [{ field: "ghost", operator: "eq", value: 1 }] };
    const draft = toDraft(tree, columns);
    expect(draft.children[0]!.type).toBe("external");
    expect(fromDraft(draft, columns)).toEqual(tree);
  });

  it("null is an empty AND root; empty groups are dropped, a single-child group is kept", () => {
    const draft = toDraft(null, columns);
    expect(shape(draft)).toEqual({ group: "AND", children: [] });
    expect(fromDraft(draft, columns)).toBeNull();

    const withGroups: DraftGroup = newGroupNode("AND", [
      newGroupNode("OR"),
      newGroupNode("OR", [newRuleNode({ field: "price", operator: "gt", value: 1 })]),
    ]);
    expect(fromDraft(withGroups, columns)).toEqual({
      operator: "AND",
      filters: [{ operator: "OR", filters: [{ field: "price", operator: "gt", value: 1 }] }],
    });
  });
});

describe("validateDraft", () => {
  it("reports incomplete rules by their ids and invalidates Apply", () => {
    const half = newRuleNode({ field: "name", operator: "contains" });
    const noField = newRuleNode();
    const draft = newGroupNode("AND", [newRuleNode({ field: "price", operator: "gt", value: 1 }), half, noField]);
    const result = validateDraft(draft, columns, limits);
    expect(result.incomplete).toEqual([half.id, noField.id]);
    expect(result.valid).toBe(false);
  });

  it("counts the depth on the compiled tree: a datetime day rule adds one level", () => {
    // Root(1) > group(2) > group(3) containing a number rule → depth 3, valid.
    const inner = newGroupNode("AND", [newRuleNode({ field: "price", operator: "gt", value: 1 })]);
    const draft = newGroupNode("AND", [newGroupNode("OR", [inner])]);
    expect(validateDraft(draft, columns, limits)).toMatchObject({ depth: 3, tooDeep: false, valid: true });

    // A datetime day rule in the same place → the gte+lt wrapper becomes level 4.
    const withDate = replaceNode(draft, inner.id, {
      ...inner,
      children: [newRuleNode({ field: "accessDate", operator: "onDay", value: "2026-01-15" })],
    });
    expect(validateDraft(withDate, columns, limits)).toMatchObject({ depth: 4, tooDeep: true, valid: false });
  });

  it("counts leaves like the backend: a datetime day rule is two leaves", () => {
    const draft = newGroupNode("AND", [newRuleNode({ field: "accessDate", operator: "onDay", value: "2026-01-15" })]);
    expect(validateDraft(draft, columns, { maxRules: 1, maxDepth: 3 })).toMatchObject({ leafCount: 2, tooManyRules: true });
  });
});

describe("draft operations", () => {
  const build = () => {
    const a = newRuleNode({ field: "name", operator: "contains", value: "A" });
    const group = newGroupNode("OR", [newRuleNode({ field: "price", operator: "gt", value: 1 })]);
    const root = newGroupNode("AND", [a, group]);
    return { root, a, group };
  };

  it("insertNode inserts into the given group at the given position", () => {
    const { root, group } = build();
    const added = newRuleNode({ field: "name", operator: "eq", value: "B" });
    const next = insertNode(root, group.id, added, 0);
    expect((next.children[1] as DraftGroup).children[0]).toBe(added);
    expect(insertNode(root, root.id, added).children.at(-1)).toBe(added);
  });

  it("removeNode deletes a nested node; unchanged branches keep the same reference", () => {
    const { root, a, group } = build();
    const next = removeNode(root, group.children[0]!.id);
    expect((next.children[1] as DraftGroup).children).toEqual([]);
    expect(next.children[0]).toBe(a);
    expect(root.children[1]).toBe(group);
  });

  it("duplicateNode copies the subtree with new ids right after itself", () => {
    const { root, group } = build();
    const next = duplicateNode(root, group.id);
    expect(next.children).toHaveLength(3);
    const copy = next.children[2] as DraftGroup;
    expect(shape(copy)).toEqual(shape(group));
    expect(copy.id).not.toBe(group.id);
    expect(copy.children[0]!.id).not.toBe(group.children[0]!.id);
  });

  it("setGroupOperator changes the connective on the root and on a subgroup; groupDepth returns the level", () => {
    const { root, group } = build();
    expect(setGroupOperator(root, root.id, "OR").operator).toBe("OR");
    expect((setGroupOperator(root, group.id, "AND").children[1] as DraftGroup).operator).toBe("AND");
    expect(groupDepth(root, root.id)).toBe(1);
    expect(groupDepth(root, group.id)).toBe(2);
    expect(groupDepth(root, "missing")).toBeNull();
  });
});
