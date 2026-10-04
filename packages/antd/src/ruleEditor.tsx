import { useEffect } from "react";
import { Checkbox, Input, InputNumber, Radio, Space, Spin, Typography } from "antd";
import type { ReactDataTableColumn } from "@datatablex/react";
import { useDataTableLocale } from "./locale.js";
import type { DataTableLocale } from "./locale.js";
import { columnField } from "@datatablex/core";
import type { Filter, FilterGroup } from "@datatablex/core";
import { ruleKindOf, ruleOf } from "@datatablex/react/filter-model";
import type { FilterRule, RuleOperator } from "@datatablex/react/filter-model";

/*
 * Shared pieces of rule editing: the chip editor of the filter bar and the
 * rows of the advanced builder use the same labels and value editors.
 */

/** Locale label of each rule operator. */
export const OPERATOR_LABEL: Record<RuleOperator, (locale: DataTableLocale) => string> = {
  contains: (l) => l.opContains,
  notContains: (l) => l.opNotContains,
  eq: (l) => l.opEq,
  neq: (l) => l.opNeq,
  startsWith: (l) => l.opStartsWith,
  notStartsWith: (l) => l.opNotStartsWith,
  endsWith: (l) => l.opEndsWith,
  notEndsWith: (l) => l.opNotEndsWith,
  gt: (l) => l.opGt,
  gte: (l) => l.opGte,
  lt: (l) => l.opLt,
  lte: (l) => l.opLte,
  between: (l) => l.opBetween,
  onDay: (l) => l.opOnDay,
  onOrAfter: (l) => l.opOnOrAfter,
  onOrBefore: (l) => l.opOnOrBefore,
  dayBetween: (l) => l.opDayBetween,
  in: (l) => l.opIn,
  notIn: (l) => l.opNotIn,
  isNull: (l) => l.opIsNull,
  isNotNull: (l) => l.opIsNotNull,
};

/** The number of values an operator takes: none, a single value, a pair (range) or a list. */
export type Arity = "none" | "single" | "pair" | "multi";

/** Returns the {@link Arity} of an operator. */
export function arityOf(operator: RuleOperator): Arity {
  if (operator === "isNull" || operator === "isNotNull") return "none";
  if (operator === "between" || operator === "dayBetween") return "pair";
  if (operator === "in" || operator === "notIn") return "multi";
  return "single";
}

/** Plain-text name of a column for chips and selectors; `title` may be a `ReactNode`. */
export function columnLabel<T>(column: ReactDataTableColumn<T>): string {
  if (column.exportTitle) return column.exportTitle;
  return typeof column.title === "string" ? column.title : column.key;
}

/** Readable text of the value of a rule (a list is joined with commas, enum values use their option labels); empty when the operator takes no value. */
export function valueLabel<T>(rule: FilterRule, column: ReactDataTableColumn<T>, locale: DataTableLocale): string {
  const { value } = rule;
  switch (arityOf(rule.operator)) {
    case "none":
      return "";
    case "pair":
      return Array.isArray(value) ? `${String(value[0])} – ${String(value[1])}` : "";
    case "multi": {
      const labels = new Map((column.options ?? []).map((o) => [o.value, o.label]));
      return Array.isArray(value) ? value.map((v) => labels.get(v as string | number) ?? String(v)).join(", ") : "";
    }
    case "single":
      if (typeof value === "boolean") return value ? locale.yes : locale.no;
      return value === undefined ? "" : String(value);
  }
}

/** One-line readable summary of a rule: column, operator and value. */
export function ruleSummary<T>(rule: FilterRule, column: ReactDataTableColumn<T>, locale: DataTableLocale): string {
  return [columnLabel(column), OPERATOR_LABEL[rule.operator](locale), valueLabel(rule, column, locale)].filter(Boolean).join(" ");
}

/** Props of {@link ValueEditor}. */
export interface ValueEditorProps<T> {
  /** The column the rule is built on; its type decides the kind of editor. */
  column: ReactDataTableColumn<T>;
  /** The operator of the rule; its arity decides whether the editor has no input, one, two or a list. */
  operator: RuleOperator;
  /** Current value: a scalar, a pair for range operators or a list for `in`/`notIn`. */
  value: unknown;
  /** Maximum number of values allowed in an "in" style value list. */
  maxInValues: number;
  /** Called with the new value on every change. */
  onChange: (value: unknown) => void;
  /** Called when the user presses Enter in one of the inputs. */
  onEnter: () => void;
  /** `TableInstance.loadOptions`: called when the editor opens for a column whose options are awaited from the server. */
  onLoadOptions?: (field: string) => void;
}

/** Value editor chosen by the column type and the arity of the operator; dates use a native `type="date"` input (no dayjs dependency). */
export function ValueEditor<T>({ column, operator, value, maxInValues, onChange, onEnter, onLoadOptions }: ValueEditorProps<T>) {
  const locale = useDataTableLocale();
  // Options are fetched lazily: the request is sent when the editor is first opened for this column.
  const pendingOptionsField = column.optionsState === "idle" ? columnField(column) : null;
  useEffect(() => {
    if (pendingOptionsField !== null) onLoadOptions?.(pendingOptionsField);
  }, [pendingOptionsField, onLoadOptions]);
  const kind = ruleKindOf(column);
  const arity = arityOf(operator);
  const label = `${columnLabel(column)} ${locale.filterValue}`;
  if (arity === "none") return null;

  const pair = Array.isArray(value) ? (value as unknown[]) : [undefined, undefined];
  const setPair = (index: 0 | 1, next: unknown) => {
    const copy = [pair[0], pair[1]];
    copy[index] = next ?? undefined;
    onChange(copy);
  };

  switch (kind) {
    case "text":
      return (
        <Input
          aria-label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onPressEnter={onEnter}
        />
      );
    case "number":
      if (arity === "pair") {
        return (
          <Space size={4}>
            <InputNumber aria-label={locale.minInput(columnLabel(column))} placeholder={locale.minPlaceholder} value={pair[0] as number | undefined} onChange={(v) => setPair(0, v)} onPressEnter={onEnter} />
            <InputNumber aria-label={locale.maxInput(columnLabel(column))} placeholder={locale.maxPlaceholder} value={pair[1] as number | undefined} onChange={(v) => setPair(1, v)} onPressEnter={onEnter} />
          </Space>
        );
      }
      return <InputNumber aria-label={label} value={typeof value === "number" ? value : undefined} onChange={(v) => onChange(v ?? undefined)} onPressEnter={onEnter} style={{ width: "100%" }} />;
    case "date":
      if (arity === "pair") {
        return (
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            <Input type="date" aria-label={locale.dateFromInput(columnLabel(column))} value={typeof pair[0] === "string" ? pair[0] : ""} onChange={(e) => setPair(0, e.target.value || undefined)} onPressEnter={onEnter} />
            <Input type="date" aria-label={locale.dateToInput(columnLabel(column))} value={typeof pair[1] === "string" ? pair[1] : ""} onChange={(e) => setPair(1, e.target.value || undefined)} onPressEnter={onEnter} />
          </Space>
        );
      }
      return <Input type="date" aria-label={label} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} onPressEnter={onEnter} />;
    case "enum": {
      const selected = Array.isArray(value) ? (value as Array<string | number>) : [];
      if (!column.options?.length) {
        return (
          <Space size={8} role="status">
            <Spin size="small" />
            <Typography.Text type="secondary">{locale.optionsLoading}</Typography.Text>
          </Space>
        );
      }
      return (
        <Checkbox.Group
          aria-label={label}
          value={selected}
          onChange={(next) => onChange(next)}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
          // `in`/`notIn` are limited by `maxInValues` on the backend; at the limit, the options that are not selected are disabled.
          options={(column.options ?? []).map((o) => ({
            label: o.label,
            value: o.value,
            disabled: selected.length >= maxInValues && !selected.includes(o.value),
          }))}
        />
      );
    }
    case "boolean":
      return (
        <Radio.Group aria-label={label} value={typeof value === "boolean" ? String(value) : undefined} onChange={(e) => onChange(e.target.value === "true")}>
          <Space direction="vertical" size={0}>
            <Radio value="true">{locale.yes}</Radio>
            <Radio value="false">{locale.no}</Radio>
          </Space>
        </Radio.Group>
      );
    default:
      return null;
  }
}

/**
 * One-line readable summary of a node. Nested groups are wrapped in
 * parentheses and joined with the connective of the group, for example
 * "(Status is any of Closed or Amount greater than 400)". A leaf that cannot be
 * resolved to a rule is reported as the locale's external condition text.
 */
export function nodeSummary<T>(
  node: Filter | FilterGroup,
  columnsByKey: Map<string, ReactDataTableColumn<T>>,
  locale: DataTableLocale,
): string {
  const rule = ruleOf(node, columnsByKey);
  if (rule) return ruleSummary(rule, columnsByKey.get(rule.field)!, locale);
  if (!("filters" in node)) return locale.externalCondition;
  const connective = ` ${node.operator === "AND" ? locale.connectiveAnd : locale.connectiveOr} `;
  return `(${node.filters.map((child) => nodeSummary(child, columnsByKey, locale)).join(connective)})`;
}
