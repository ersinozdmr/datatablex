/**
 * `@datatablex/react/filter-model`: the filter building blocks that do not
 * depend on any UI library. `@datatablex/antd` uses them; another UI kit (MUI,
 * your own design system) can build its own components on the same rule model
 * and draft tree. The whole subpath is experimental: its only consumer is
 * `@datatablex/antd`, and it has not been validated against a second UI kit.
 *
 * @experimental May change in any release while the package is in 0.x.
 */
export type {
  DateRuleOperator,
  FilterEntry,
  FilterRule,
  NullRuleOperator,
  NumberRuleOperator,
  RuleKind,
  RuleOperator,
  TextRuleOperator,
} from "./state/filterRules.js";
export { columnsByField, excludesNulls, nodeToRule, readEntries, ruleKindOf, ruleOf, ruleOperatorsFor, ruleToNode, writeEntries } from "./state/filterRules.js";
export type { DraftGroup, DraftLimits, DraftNode, DraftRuleValue, DraftValidation, FilterTreeCheck } from "./state/filterDraft.js";
export {
  checkFilterTree,
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
} from "./state/filterDraft.js";
