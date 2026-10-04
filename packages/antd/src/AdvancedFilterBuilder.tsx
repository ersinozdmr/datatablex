import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Select, Space, Typography, theme } from "antd";
import { columnField, filtersEqual } from "@datatablex/core";
import type { ReactDataTableColumn, TableInstance } from "@datatablex/react";
import { useDataTableLocale } from "./locale.js";
import {
  duplicateNode,
  fromDraft,
  insertNode,
  newGroupNode,
  newRuleNode,
  removeNode,
  replaceNode,
  setGroupOperator,
  toDraft,
  validateDraft,
} from "@datatablex/react/filter-model";
import type { DraftGroup, DraftNode, DraftRuleValue } from "@datatablex/react/filter-model";
import { columnsByField, excludesNulls, ruleOperatorsFor } from "@datatablex/react/filter-model";
import type { FilterRule, RuleOperator } from "@datatablex/react/filter-model";
import { CloseIcon, CopyIcon } from "./icons.js";
import { OPERATOR_LABEL, ValueEditor, arityOf, columnLabel, ruleSummary } from "./ruleEditor.js";

/** State and callbacks the builder passes down to its group and rule editors. */
interface BuilderContext<T> {
  /** The root group of the draft. */
  root: DraftGroup;
  /** All columns, including those a rule cannot be built on. */
  columns: ReactDataTableColumn<T>[];
  /** Columns a rule can be built on. */
  ruleColumns: ReactDataTableColumn<T>[];
  /** The columns by field key. */
  columnByKey: Map<string, ReactDataTableColumn<T>>;
  /** Maximum depth of the filter tree. */
  maxDepth: number;
  /** Maximum number of values allowed in an "in" style value list. */
  maxInValues: number;
  /** Ids of the draft rules that are not complete yet. */
  incomplete: Set<string>;
  /** Asks for the options of a column with server-provided options. */
  loadOptions: ((field: string) => void) | undefined;
  /** Updates the draft; if `focus` is given, that node receives focus one frame later. */
  update: (next: DraftGroup, focus?: string) => void;
}

/** Where focus goes after a node is deleted: the next sibling, otherwise the previous one, otherwise the parent group. */
function neighbourOf(group: DraftGroup, index: number): string {
  return group.children[index + 1]?.id ?? group.children[index - 1]?.id ?? group.id;
}

/** The duplicate and delete buttons of a rule or group node. */
function NodeActions({ label, onDuplicate, onDelete }: { label: string; onDuplicate: () => void; onDelete: () => void }) {
  const locale = useDataTableLocale();
  return (
    <Space size={0}>
      <Button type="text" size="small" icon={<CopyIcon />} aria-label={locale.duplicateNode(label)} onClick={onDuplicate} />
      <Button type="text" size="small" icon={<CloseIcon />} aria-label={locale.deleteNode(label)} onClick={onDelete} />
    </Space>
  );
}

/** One rule of the draft: field, operator and value editors plus the node actions. */
function RuleRow<T>({ id, rule, parent, index, ctx }: { id: string; rule: DraftRuleValue; parent: DraftGroup; index: number; ctx: BuilderContext<T> }) {
  const locale = useDataTableLocale();
  const { token } = theme.useToken();
  const column = rule.field ? ctx.columnByKey.get(rule.field) : undefined;
  const operators = column ? ruleOperatorsFor(column) : [];
  const incomplete = ctx.incomplete.has(id);
  const label = column && !incomplete ? ruleSummary(rule as FilterRule, column, locale) : locale.newRule;

  const setRule = (next: DraftRuleValue) => ctx.update(replaceNode(ctx.root, id, { id, type: "rule", rule: next }));
  const selectField = (field: string) => {
    const nextColumn = ctx.columnByKey.get(field);
    setRule({ field, operator: nextColumn ? ruleOperatorsFor(nextColumn)[0] : undefined });
  };
  const selectOperator = (operator: RuleOperator) =>
    // A value of the same shape is kept (for example "contains" to "does not contain"); it is reset when the shape changes.
    setRule({ ...rule, operator, value: rule.operator && arityOf(rule.operator) === arityOf(operator) ? rule.value : undefined });

  return (
    <div
      data-node-id={id}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: 8,
        padding: 4,
        borderRadius: token.borderRadiusSM,
        // An incomplete rule blocks "Apply"; the row makes that visible.
        outline: incomplete ? `1px dashed ${token.colorWarningBorder}` : undefined,
      }}
    >
      <Select
        aria-label={locale.filterField}
        placeholder={locale.filterField}
        value={rule.field}
        onChange={selectField}
        style={{ width: 170 }}
        options={ctx.ruleColumns.map((c) => ({ value: columnField(c) as string, label: columnLabel(c) }))}
      />
      {column ? (
        <Select<RuleOperator>
          aria-label={locale.filterOperator}
          value={rule.operator}
          onChange={selectOperator}
          style={{ width: 190 }}
          options={operators.map((op) => ({ value: op, label: OPERATOR_LABEL[op](locale) }))}
        />
      ) : null}
      {column && rule.operator ? (
        <div style={{ minWidth: 180 }}>
          <ValueEditor
            column={column}
            operator={rule.operator}
            value={rule.value}
            maxInValues={ctx.maxInValues}
            onChange={(value) => setRule({ ...rule, value })}
            onEnter={() => {}}
            onLoadOptions={ctx.loadOptions}
          />
        </div>
      ) : null}
      {rule.operator && excludesNulls(rule.operator) ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, alignSelf: "center" }}>
          {locale.nullsExcludedHint}
        </Typography.Text>
      ) : null}
      <NodeActions
        label={label}
        onDuplicate={() => ctx.update(duplicateNode(ctx.root, id))}
        onDelete={() => ctx.update(removeNode(ctx.root, id), neighbourOf(parent, index))}
      />
    </div>
  );
}

/** A group of the draft: its children, the connective selector and the buttons to add a rule or a subgroup. Subgroups render recursively. */
function GroupEditor<T>({ group, depth, parent, index, ctx }: { group: DraftGroup; depth: number; parent?: DraftGroup; index?: number; ctx: BuilderContext<T> }) {
  const locale = useDataTableLocale();
  const { token } = theme.useToken();
  const groupLabel = group.operator === "AND" ? locale.groupAll : locale.groupAny;
  const connective = group.operator === "AND" ? locale.connectiveAnd : locale.connectiveOr;
  // The root is level 1; a subgroup added inside this group sits at `depth + 1`.
  const canAddGroup = depth + 1 <= ctx.maxDepth;

  return (
    <div
      role="group"
      aria-label={groupLabel}
      data-node-id={group.id}
      style={
        parent
          ? { border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadius, padding: 8, background: token.colorFillQuaternary }
          : undefined
      }
    >
      {parent ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <NodeActions
            label={groupLabel}
            onDuplicate={() => ctx.update(duplicateNode(ctx.root, group.id))}
            onDelete={() => ctx.update(removeNode(ctx.root, group.id), neighbourOf(parent, index ?? 0))}
          />
        </div>
      ) : null}
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        {group.children.map((child: DraftNode, i) => (
          <div key={child.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <div style={{ width: 84, flex: "none", paddingTop: 5 }}>
              {i === 0 ? (
                <Typography.Text type="secondary">{locale.where}</Typography.Text>
              ) : i === 1 ? (
                // A group has a single connective; the selector appears only on the second row and changes the whole group.
                <Select<"AND" | "OR">
                  size="small"
                  aria-label={locale.connective}
                  value={group.operator}
                  onChange={(operator) => ctx.update(setGroupOperator(ctx.root, group.id, operator))}
                  options={[
                    { value: "AND", label: locale.connectiveAnd },
                    { value: "OR", label: locale.connectiveOr },
                  ]}
                  style={{ width: 76 }}
                />
              ) : (
                <Typography.Text type="secondary">{connective}</Typography.Text>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {child.type === "group" ? (
                <GroupEditor group={child} depth={depth + 1} parent={group} index={i} ctx={ctx} />
              ) : child.type === "rule" ? (
                <RuleRow id={child.id} rule={child.rule} parent={group} index={i} ctx={ctx} />
              ) : (
                <div data-node-id={child.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Typography.Text type="secondary">{locale.externalCondition}</Typography.Text>
                  <NodeActions
                    label={locale.externalCondition}
                    onDuplicate={() => ctx.update(duplicateNode(ctx.root, child.id))}
                    onDelete={() => ctx.update(removeNode(ctx.root, child.id), neighbourOf(group, i))}
                  />
                </div>
              )}
            </div>
          </div>
        ))}
        <Space size={4} style={{ paddingInlineStart: 92 }}>
          <Button
            size="small"
            type="dashed"
            onClick={() => {
              const rule = newRuleNode();
              ctx.update(insertNode(ctx.root, group.id, rule), rule.id);
            }}
          >
            + {locale.addRule}
          </Button>
          <Button
            size="small"
            type="dashed"
            disabled={!canAddGroup}
            title={canAddGroup ? undefined : locale.depthLimitReached(ctx.maxDepth)}
            onClick={() => {
              const sub = newGroupNode("AND", [newRuleNode()]);
              ctx.update(insertNode(ctx.root, group.id, sub), sub.id);
            }}
          >
            + {locale.addGroup}
          </Button>
        </Space>
      </Space>
    </div>
  );
}

/** Props of {@link AdvancedFilterBuilder}. */
export interface AdvancedFilterBuilderProps<T> {
  /** The table instance whose filters the builder reads (`table.filters`, `table.lockedFilters`) and writes (`table.setFilters`). */
  table: TableInstance<T>;
  /** Columns a rule can be built on; the builder offers those that support at least one operator. */
  columns: ReactDataTableColumn<T>[];
  /** Maximum number of leaves in the whole tree (counted the same way as the backend `maxFilterCount`). */
  maxRules: number;
  /** Maximum depth of the filter tree (counted the same way as the backend `maxFilterDepth`). */
  maxDepth: number;
  /** Maximum number of values allowed in an "in" style value list. */
  maxInValues: number;
  /** Called when the builder should close: after "Apply" or "Cancel". */
  onClose: () => void;
  /**
   * The "Open in builder" action of the filter bar: for every new request
   * object, the child of the root group at `index` receives focus. The root of
   * the draft carries the root children of the applied tree in the same order,
   * so the entry order of the filter bar can be used directly.
   */
  focusRequest?: { index: number; seq: number } | null;
}

/**
 * The advanced filter builder. The draft lives only here: it is built from
 * `table.filters` when the builder opens, "Apply" makes a single
 * `setFilters(fromDraft(...))` call, and "Cancel" discards the draft. `Escape`
 * does not close the panel, because the draft would be lost.
 *
 * If the filters change from outside while the draft is open (a chip was
 * removed, a dashboard injected a filter), the draft is refreshed silently when
 * it has no changes; when it does, a warning and a reload button are shown
 * instead of overwriting the user's edits.
 */
export function AdvancedFilterBuilder<T>({ table, columns, maxRules, maxDepth, maxInValues, onClose, focusRequest }: AdvancedFilterBuilderProps<T>) {
  const locale = useDataTableLocale();
  const { token } = theme.useToken();
  const [base, setBase] = useState(table.filters);
  const [draft, setDraft] = useState(() => toDraft(table.filters, columns));
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  const ruleColumns = useMemo(() => columns.filter((c) => ruleOperatorsFor(c).length > 0), [columns]);
  const columnByKey = useMemo(() => columnsByField(columns), [columns]);
  const locked = table.lockedFilters;
  const validation = useMemo(() => validateDraft(draft, columns, { maxRules, maxDepth, locked }), [draft, columns, maxRules, maxDepth, locked]);

  const reload = useCallback(() => {
    setBase(table.filters);
    setDraft(toDraft(table.filters, columns));
    setDirty(false);
    setStale(false);
  }, [table.filters, columns]);

  useEffect(() => {
    if (filtersEqual(table.filters, base)) return;
    if (dirty) setStale(true);
    else reload();
  }, [table.filters, base, dirty, reload]);

  // After an insert or delete, focus moves to the new row or to the neighbour
  // of the deleted one; the node enters the DOM on the next render, so one
  // frame is awaited. The request is one-shot: if it were not cleared, every
  // later edit would pull focus back.
  useEffect(() => {
    if (!focusId) return;
    const id = requestAnimationFrame(() => {
      // Input first: in a group, the field of the first rule gets focus rather than the duplicate/delete buttons in the group header.
      const node = panelRef.current?.querySelector(`[data-node-id="${focusId}"]`);
      (node?.querySelector<HTMLElement>("input") ?? node?.querySelector<HTMLElement>("button"))?.focus();
      setFocusId(null);
    });
    return () => cancelAnimationFrame(id);
  }, [focusId]);

  // The request is handled only for a new object, so the current draft is read through a ref instead of being a dependency.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    if (!focusRequest) return;
    const target = draftRef.current.children[focusRequest.index];
    if (target) setFocusId(target.id);
  }, [focusRequest]);

  const update = useCallback((next: DraftGroup, focus?: string) => {
    setDraft(next);
    setDirty(true);
    if (focus) setFocusId(focus);
  }, []);

  const apply = () => {
    if (!validation.valid) return;
    table.setFilters(fromDraft(draft, columns));
    onClose();
  };

  const ctx: BuilderContext<T> = {
    root: draft,
    columns,
    ruleColumns,
    columnByKey,
    maxDepth,
    maxInValues,
    incomplete: new Set(validation.incomplete),
    loadOptions: table.loadOptions,
    update,
  };

  const problems = [
    validation.incomplete.length ? locale.incompleteRules(validation.incomplete.length) : null,
    validation.tooManyRules ? locale.filterLimitReached(maxRules) : null,
    validation.tooDeep ? locale.depthLimitReached(maxDepth) : null,
  ].filter((p): p is string => p !== null);

  return (
    <section
      ref={panelRef}
      aria-label={locale.advancedFilter}
      style={{ border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadiusLG, padding: 12 }}
    >
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        {stale ? (
          <Alert
            type="warning"
            showIcon
            message={locale.filtersChangedElsewhere}
            action={
              <Button size="small" onClick={reload}>
                {locale.reloadDraft}
              </Button>
            }
          />
        ) : null}
        <GroupEditor group={draft} depth={1} ctx={ctx} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Typography.Text type={problems.length ? "danger" : "secondary"} style={{ fontSize: 12 }}>
            {problems.join(" · ")}
          </Typography.Text>
          <Space>
            <Button size="small" onClick={onClose}>
              {locale.cancel}
            </Button>
            <Button size="small" type="primary" disabled={!validation.valid} onClick={apply}>
              {locale.apply}
            </Button>
          </Space>
        </div>
      </Space>
    </section>
  );
}
