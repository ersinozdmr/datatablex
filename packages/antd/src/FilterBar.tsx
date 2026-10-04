import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Dropdown, Popover, Select, Space, Typography, theme } from "antd";
import { andFilterGroups, columnField, countFilterLeaves } from "@datatablex/core";
import type { ReactDataTableColumn, TableInstance } from "@datatablex/react";
import { useDataTableLocale } from "./locale.js";
import { columnsByField, excludesNulls, readEntries, ruleOperatorsFor, ruleToNode, writeEntries } from "@datatablex/react/filter-model";
import type { FilterEntry, FilterRule, RuleOperator } from "@datatablex/react/filter-model";
import { CloseIcon, LockIcon, MoreIcon } from "./icons.js";
import { AdvancedFilterBuilder } from "./AdvancedFilterBuilder.js";
import { checkFilterTree } from "@datatablex/react/filter-model";
import { OPERATOR_LABEL, ValueEditor, arityOf, columnLabel, nodeSummary, ruleSummary, valueLabel } from "./ruleEditor.js";

/** Props of the rule editor popover content. */
interface RuleEditorProps<T> {
  /** Columns a rule can be built on. */
  columns: ReactDataTableColumn<T>[];
  /** The rule being edited, or `null` for a new rule. */
  initial: FilterRule | null;
  /** Maximum number of values allowed in an "in" style value list. */
  maxInValues: number;
  /** Message for the limit the tree would exceed if the rule were applied; `null` if it can be applied. */
  limitError: (rule: FilterRule) => string | null;
  /** Called with the finished rule when the user applies it. */
  onApply: (rule: FilterRule) => void;
  /** Asks for the options of a column with server-provided options. */
  onLoadOptions?: (field: string) => void;
}

/**
 * Draft of a single rule: field, then operator, then value. The draft lives
 * only here; "Apply" produces a single `setFilters` call (each chip is applied
 * on its own).
 */
function RuleEditor<T>({ columns, initial, maxInValues, limitError, onApply, onLoadOptions }: RuleEditorProps<T>) {
  const locale = useDataTableLocale();
  const [field, setField] = useState<string | undefined>(initial?.field);
  const column = columns.find((c) => columnField(c) === field);
  const operators = useMemo(() => (column ? ruleOperatorsFor(column) : []), [column]);
  const [operator, setOperator] = useState<RuleOperator | undefined>(initial?.operator);
  const [value, setValue] = useState<unknown>(initial?.value);

  const selectField = (next: string) => {
    setField(next);
    const nextColumn = columns.find((c) => columnField(c) === next);
    setOperator(nextColumn ? ruleOperatorsFor(nextColumn)[0] : undefined);
    setValue(undefined);
  };
  const selectOperator = (next: RuleOperator) => {
    // A value of the same shape is kept (for example "contains" to "does not contain"); it is reset when the shape changes.
    if (!operator || arityOf(operator) !== arityOf(next)) setValue(undefined);
    setOperator(next);
  };

  // The popover content can mount before it is visible, so `autoFocus` alone is
  // not reliable; focus is given explicitly one frame later. If the field is
  // known (chip editing or the header shortcut) the value editor gets focus,
  // otherwise the field selector does.
  const rootRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const target = (initial ? valueRef.current?.querySelector<HTMLElement>("input") : null) ?? rootRef.current?.querySelector<HTMLElement>("input");
      target?.focus();
    });
    return () => cancelAnimationFrame(id);
    // Only on open: the editor remounts on every open (see the `key` in `editorFor`).
  }, [initial]);

  const rule: FilterRule | null = column && operator ? { field: columnField(column) as string, operator, value } : null;
  const compiles = Boolean(rule && column && ruleToNode(rule, column));
  const error = rule && compiles ? limitError(rule) : null;
  const apply = () => {
    if (rule && compiles && !error) onApply(rule);
  };

  return (
    <Space ref={rootRef} direction="vertical" size={8} style={{ width: 260 }}>
      <Select
        aria-label={locale.filterField}
        placeholder={locale.filterField}
        value={field}
        onChange={selectField}
        style={{ width: "100%" }}
        options={columns.map((c) => ({ value: columnField(c) as string, label: columnLabel(c) }))}
      />
      {column ? (
        <Select<RuleOperator>
          aria-label={locale.filterOperator}
          value={operator}
          onChange={selectOperator}
          style={{ width: "100%" }}
          options={operators.map((op) => ({ value: op, label: OPERATOR_LABEL[op](locale) }))}
        />
      ) : null}
      {column && operator ? (
        <div ref={valueRef}>
          <ValueEditor column={column} operator={operator} value={value} maxInValues={maxInValues} onChange={setValue} onEnter={apply} onLoadOptions={onLoadOptions} />
        </div>
      ) : null}
      {field !== undefined && !column ? (
        // The column went away while the editor was open: the server options came back empty or could not be fetched.
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {locale.optionsUnavailable}
        </Typography.Text>
      ) : null}
      {column && operator && excludesNulls(operator) ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {locale.nullsExcludedHint}
        </Typography.Text>
      ) : null}
      {error ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {error}
        </Typography.Text>
      ) : null}
      <Space style={{ width: "100%", justifyContent: "flex-end" }}>
        <Button size="small" type="primary" disabled={!compiles || Boolean(error)} onClick={apply}>
          {locale.apply}
        </Button>
      </Space>
    </Space>
  );
}

/** The visible text of a group summary chip is cut at this length; the full text stays in the accessible name and in `title`. */
const SUMMARY_MAX_LENGTH = 48;

/** Cuts a summary to {@link SUMMARY_MAX_LENGTH} characters, ending with an ellipsis when it was cut. */
function truncate(text: string): string {
  return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : text;
}

/** A filter chip: the summary content, optional extra actions and a remove button. */
function Chip({ children, actions, onRemove, removeLabel }: { children: ReactNode; actions?: ReactNode; onRemove: () => void; removeLabel: string }) {
  const { token } = theme.useToken();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadiusSM,
        background: token.colorFillQuaternary,
      }}
    >
      {children}
      {actions}
      <Button type="text" size="small" icon={<CloseIcon />} aria-label={removeLabel} onClick={onRemove} />
    </span>
  );
}

/**
 * Summary of the locked (host-provided) filters: they cannot be removed or
 * edited, and "Clear all" does not touch them.
 */
function LockedChip({ summary }: { summary: string }) {
  const { token } = theme.useToken();
  const locale = useDataTableLocale();
  return (
    <span
      role="note"
      aria-label={locale.lockedFilter(summary)}
      title={`${summary} — ${locale.lockedFilterHint}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 8px",
        border: `1px dashed ${token.colorBorder}`,
        borderRadius: token.borderRadiusSM,
        color: token.colorTextSecondary,
      }}
    >
      <LockIcon />
      {truncate(summary)}
    </span>
  );
}

/** Props of {@link FilterBar}. */
export interface FilterBarProps<T> {
  /** The table instance whose filters the bar reads (`table.filters`, `table.lockedFilters`) and writes (`table.setFilters`). */
  table: TableInstance<T>;
  /** Columns a rule can be built on, including hidden columns (a rule is part of the query and does not depend on visibility). */
  columns: ReactDataTableColumn<T>[];
  /** Maximum number of leaves in the whole tree (counted the same way as the backend `maxFilterCount`). */
  maxRules: number;
  /** Maximum number of values allowed in an "in" style value list. */
  maxInValues: number;
  /**
   * The "Filter" shortcut of the column header menu. For every new request
   * object, if the field has exactly one rule that chip opens for editing;
   * otherwise a new rule editor opens with the field preselected and the value
   * editor focused.
   */
  request?: { field: string; seq: number } | null;
  /** `"advanced"`: the bar gets an "Advanced" button and the builder panel that opens below it. */
  mode?: "simple" | "advanced";
  /** Maximum depth of the filter tree (counted the same way as the backend `maxFilterDepth`); enforced in both modes. */
  maxDepth?: number;
}

type Editing = number | "new" | null;

/**
 * The filter bar above the table. It has no persistent state of its own: the
 * chips are derived from `table.filters` on every render, so a `setFilters`
 * call made from outside the table is reflected immediately. Nodes the bar
 * cannot represent are shown as a read-only "external filter" chip and are
 * kept in place on every write.
 */
export function FilterBar<T>({ table, columns, maxRules, maxInValues, request, mode = "simple", maxDepth = 3 }: FilterBarProps<T>) {
  const locale = useDataTableLocale();
  const [editing, setEditing] = useState<Editing>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderFocus, setBuilderFocus] = useState<{ index: number; seq: number } | null>(null);
  const advanced = mode === "advanced";
  /** Field preselected in the new-rule editor; it only comes from the header shortcut. */
  const [presetField, setPresetField] = useState<string | null>(null);

  const ruleColumns = useMemo(() => columns.filter((c) => ruleOperatorsFor(c).length > 0), [columns]);
  const columnByKey = useMemo(() => columnsByField(columns), [columns]);
  const entries = useMemo(() => readEntries(table.filters, columns), [table.filters, columns]);
  // Locked filters (`table.lockedFilters`) are sent to the query combined with the user filters; the limits are counted on the combined tree too.
  const locked = table.lockedFilters;
  const leafCount = countFilterLeaves(andFilterGroups(locked, table.filters));
  const lockedSummary = locked
    ? locked.operator === "AND"
      ? locked.filters.map((child) => nodeSummary(child, columnByKey, locale)).join(` ${locale.connectiveAnd} `)
      : nodeSummary(locked, columnByKey, locale)
    : null;

  // The shortcut only reacts to a new request; the editor must not reopen when
  // the filters change. For that reason the current entries are read through a
  // ref instead of being a dependency (the same pattern as
  // `useLatestDataSource` in `useDataTable`).
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  useEffect(() => {
    if (!request) return;
    const indexes = entriesRef.current.flatMap((e, i) => (e.type === "rule" && e.rule.field === request.field ? [i] : []));
    if (indexes.length === 1) {
      setPresetField(null);
      setEditing(indexes[0]!);
    } else {
      setPresetField(request.field);
      setEditing("new");
    }
  }, [request]);

  const write = (next: FilterEntry[]) => table.setFilters(writeEntries(next, columns));
  const withRule = (index: number | "new", rule: FilterRule): FilterEntry[] =>
    index === "new" ? [...entries, { type: "rule", rule }] : entries.map((e, i) => (i === index ? { type: "rule", rule } : e));
  const limitErrorFor = (index: number | "new") => (rule: FilterRule) => {
    const check = checkFilterTree(writeEntries(withRule(index, rule), columns), { maxRules, maxDepth, locked });
    if (check.tooManyRules) return locale.filterLimitReached(maxRules);
    return check.tooDeep ? locale.depthLimitReached(maxDepth) : null;
  };

  const apply = (index: number | "new", rule: FilterRule) => {
    write(withRule(index, rule));
    setEditing(null);
  };
  const remove = (index: number) => write(entries.filter((_, i) => i !== index));
  const withDuplicate = (index: number): FilterEntry[] => [...entries.slice(0, index + 1), entries[index]!, ...entries.slice(index + 1)];
  const canDuplicate = (index: number) => {
    const check = checkFilterTree(writeEntries(withDuplicate(index), columns), { maxRules, maxDepth, locked });
    return !check.tooManyRules && !check.tooDeep;
  };
  const openInBuilder = (index: number) => {
    setBuilderOpen(true);
    setBuilderFocus((prev) => ({ index, seq: (prev?.seq ?? 0) + 1 }));
  };

  /** The "⋯" menu of a chip in advanced mode. */
  const chipMenu = (index: number, summary: string, onEdit: (() => void) | null) =>
    advanced ? (
      <Dropdown
        trigger={["click"]}
        menu={{
          items: [
            ...(onEdit ? [{ key: "edit", label: locale.menuEdit }] : []),
            { key: "duplicate", label: locale.menuDuplicate, disabled: !canDuplicate(index) },
            { key: "builder", label: locale.menuOpenInBuilder },
            { key: "remove", label: locale.menuRemove, danger: true },
          ],
          onClick: ({ key }) => {
            if (key === "edit") onEdit?.();
            else if (key === "duplicate") write(withDuplicate(index));
            else if (key === "builder") openInBuilder(index);
            else remove(index);
          },
        }}
      >
        <Button type="text" size="small" icon={<MoreIcon />} aria-label={locale.chipActions(summary)} />
      </Dropdown>
    ) : null;

  const presetColumn = presetField ? ruleColumns.find((c) => columnField(c) === presetField) : undefined;
  const presetRule: FilterRule | null = presetColumn ? { field: columnField(presetColumn) as string, operator: ruleOperatorsFor(presetColumn)[0]! } : null;

  const editorFor = (index: number | "new", initial: FilterRule | null) => (
    <RuleEditor
      // Every open restarts the draft from the applied rule.
      key={`${String(index)}-${editing === index ? "open" : "closed"}-${index === "new" ? (presetField ?? "") : ""}`}
      columns={ruleColumns}
      initial={initial}
      maxInValues={maxInValues}
      limitError={limitErrorFor(index)}
      onApply={(rule) => apply(index, rule)}
      onLoadOptions={table.loadOptions}
    />
  );

  const bar = (
    <div role="group" aria-label={locale.filterBar} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {lockedSummary ? <LockedChip summary={lockedSummary} /> : null}
      {entries.map((entry, index) => {
        if (entry.type === "external") {
          // In advanced mode groups can be represented: their readable summary is shown and clicking it opens the group in the builder.
          if (advanced && "filters" in entry.node) {
            const summary = nodeSummary(entry.node, columnByKey, locale);
            return (
              <Chip key={`group-${index}`} actions={chipMenu(index, summary, () => openInBuilder(index))} onRemove={() => remove(index)} removeLabel={locale.removeFilter(summary)}>
                <Button type="text" size="small" title={summary} aria-label={locale.editFilter(summary)} onClick={() => openInBuilder(index)}>
                  {truncate(summary)}
                </Button>
              </Chip>
            );
          }
          const summary = locale.externalFilter(countFilterLeaves(entry.node));
          return (
            <Chip key={`external-${index}`} actions={chipMenu(index, summary, null)} onRemove={() => remove(index)} removeLabel={locale.removeFilter(summary)}>
              <Typography.Text style={{ padding: "0 8px" }}>{summary}</Typography.Text>
            </Chip>
          );
        }
        const column = columnByKey.get(entry.rule.field)!;
        const summary = ruleSummary(entry.rule, column, locale);
        return (
          <Chip key={`rule-${index}`} actions={chipMenu(index, summary, () => setEditing(index))} onRemove={() => remove(index)} removeLabel={locale.removeFilter(summary)}>
            <Popover
              trigger="click"
              placement="bottomLeft"
              open={editing === index}
              onOpenChange={(open) => setEditing(open ? index : null)}
              content={editorFor(index, entry.rule)}
            >
              <Button type="text" size="small" aria-label={locale.editFilter(summary)}>
                <strong>{columnLabel(column)}</strong>&nbsp;{OPERATOR_LABEL[entry.rule.operator](locale)}
                {valueLabel(entry.rule, column, locale) ? <>&nbsp;{valueLabel(entry.rule, column, locale)}</> : null}
              </Button>
            </Popover>
          </Chip>
        );
      })}
      <Popover
        trigger="click"
        placement="bottomLeft"
        open={editing === "new"}
        onOpenChange={(open) => {
          setPresetField(null);
          setEditing(open ? "new" : null);
        }}
        content={editorFor("new", presetRule)}
      >
        <Button size="small" type="dashed" disabled={!ruleColumns.length || leafCount >= maxRules}>
          + {locale.addFilter}
        </Button>
      </Popover>
      {advanced ? (
        <Button size="small" aria-expanded={builderOpen} onClick={() => setBuilderOpen((open) => !open)}>
          {locale.advancedFilter}
        </Button>
      ) : null}
      {entries.length ? (
        <Button size="small" type="link" onClick={() => table.setFilters(null)}>
          {locale.clearAllFilters}
        </Button>
      ) : null}
    </div>
  );

  if (!advanced) return bar;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {bar}
      {builderOpen ? (
        <AdvancedFilterBuilder
          table={table}
          columns={columns}
          maxRules={maxRules}
          maxDepth={maxDepth}
          maxInValues={maxInValues}
          onClose={() => setBuilderOpen(false)}
          focusRequest={builderFocus}
        />
      ) : null}
    </div>
  );
}
