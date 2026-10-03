import type { FilterOperator } from "@datatablex/core";
import type { BaseCtx, DataTableEndpointConfig } from "./types.js";
import { DEFAULT_MAX_OPTIONS } from "./types.js";
import { resolveLimits, validateLimits } from "./limits.js";
import { EXCEL_MAX_DATA_ROWS, MAX_TIMER_MS, SERVER_EXPORT_FORMATS, projectedKeys, resolveExportConfig } from "./projection.js";
import { assertExportPackageInstalled } from "./exportWriters/packages.js";

const SENSITIVE_ALLOWED_OPERATORS = new Set<FilterOperator>(["eq", "isNull", "isNotNull"]);
/** Operators compiled to `ILIKE`/`NOT ILIKE` — valid only on a `type: "text"` field. */
const TEXT_OPERATORS = new Set<FilterOperator>(["contains", "startsWith", "endsWith", "notContains", "notStartsWith", "notEndsWith"]);

/**
 * Checks the shape of an option list: items of the form
 * `{ label: string, value: string | number }`. Returns the reason when the
 * shape is invalid, `null` otherwise. Applied to a static list at boot and to
 * the resolver's result on each request.
 */
export function optionsShapeProblem(options: unknown): string | null {
  if (!Array.isArray(options)) return `must be an array, received: ${typeof options}`;
  const index = options.findIndex((option: unknown) => {
    if (typeof option !== "object" || option === null) return true;
    const { label, value } = option as { label?: unknown; value?: unknown };
    return typeof label !== "string" || !(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)));
  });
  return index === -1 ? null : `item ${index} is not of the form { label: string, value: string | number }`;
}

/** Config objects that have already been validated — the same object is not re-validated on every request. */
const validated = new WeakSet<object>();

/**
 * Boot-time rules for an endpoint config: `primaryKey`, `select`, limits,
 * `stableSort`, the sensitive-field allowlist, and text operators requiring
 * `type: "text"`. Throws on an invalid config.
 *
 * `datatableRoute` calls this when the application starts. The internal
 * `validateDataTableQuery`, `handleDataTableQuery` and
 * `describeDataTableEndpoint` call it too, so code that uses those internals
 * directly (for example tests) does not lose the sensitive-field and limit
 * guarantees. The result is remembered per config OBJECT: a config that is
 * mutated in place after it was validated is not validated again.
 *
 * @example
 * ```ts
 * assertValidEndpointConfig(config); // throws if the config is invalid
 * ```
 *
 * @throws {Error} When the config breaks any of the rules above.
 */
export function assertValidEndpointConfig<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  config: DataTableEndpointConfig<DB, TB, Ctx>,
): void {
  if (validated.has(config)) return;
  // `baseQuery` is not supported. The type already catches it, but if the field
  // were SILENTLY ignored in a config coming from JS, the row scope
  // (tenant/soft-delete) would be lost and the endpoint would fail open.
  if ("baseQuery" in config) {
    throw new Error("`baseQuery` is not supported; use `scope: (eb, ctx) => eb(...)` for the row scope");
  }
  if (config.scope !== undefined && typeof config.scope !== "function") {
    throw new Error(`scope must be a function, received: ${typeof config.scope}`);
  }
  if (!config.fields[config.primaryKey]) {
    throw new Error(`primaryKey "${config.primaryKey}" is not defined in fields`);
  }
  if (!config.fields[config.primaryKey]!.filterOperators?.includes("in")) {
    // Exporting selected rows ALWAYS uses "in" (even for a single row), so
    // checking for "eq" would miss exactly the error this check must prevent.
    throw new Error(`primaryKey "${config.primaryKey}" filterOperators must include "in"`);
  }
  for (const key of config.select ?? []) {
    if (!config.fields[key]) throw new Error(`select key "${key}" is not defined in fields`);
    if (config.fields[key]!.sensitive) {
      throw new Error(`select key "${key}" is a sensitive field — sensitive fields cannot be projected`);
    }
  }
  if (config.fields[config.primaryKey]!.sensitive) {
    throw new Error(`primaryKey "${config.primaryKey}" cannot be sensitive — the primary key is returned in every response`);
  }
  validateLimits(resolveLimits(config));
  const sensitiveColumns = new Map(
    Object.entries(config.fields)
      .filter(([, f]) => f.sensitive)
      .map(([key, f]) => [f.column as string, key]),
  );
  const stableSortColumns = new Set<string>();
  for (const s of config.stableSort ?? []) {
    // `sortable: false` hides the value order of a sensitive field; if the same
    // column enters ORDER BY as a tiebreaker, the order leaks anyway.
    const sensitiveKey = sensitiveColumns.get(s.column);
    if (sensitiveKey !== undefined) {
      throw new Error(`stableSort column "${s.column}" belongs to sensitive field "${sensitiveKey}" — sorting leaks the order of the value`);
    }
    if (stableSortColumns.has(s.column)) throw new Error(`stableSort column "${s.column}" is given more than once`);
    stableSortColumns.add(s.column);
  }
  // The primary key is unique: tiebreakers that come AFTER it never change the
  // order of any row. If the PK is not given, the handler appends it at the end.
  const pkColumn = config.fields[config.primaryKey]!.column as string;
  const stableSort = config.stableSort ?? [];
  const pkIndex = stableSort.findIndex((s) => s.column === pkColumn);
  if (pkIndex !== -1 && pkIndex !== stableSort.length - 1) {
    throw new Error(`in stableSort the primaryKey column "${pkColumn}" must be last — keys after it do not affect the order`);
  }
  const projected = new Set(projectedKeys(config));
  // The shape of the `export` block is validated below (`assertValidExportConfig`); here only a well-formed field list is read.
  const exportFields = config.export === undefined ? [] : Array.isArray(config.export?.fields) ? config.export.fields : [...projected];
  const exportedKeys = new Set<string>(exportFields);
  for (const [key, f] of Object.entries(config.fields)) {
    // EVERY field key that maps a sensitive column (whether it is `sensitive`
    // itself or an alias) is subject to the same rules: the rule is tied to the
    // column, not to the key. Otherwise `{ column: "nationalId", filterOperators: ["contains"] }`
    // added as a second key would silently remove the protection.
    const sensitiveKey = sensitiveColumns.get(f.column as string);
    const isAlias = sensitiveKey !== undefined && !f.sensitive;
    if (f.declassify && !isAlias) {
      throw new Error(`field "${key}" sets declassify: true but does not map a sensitive column — the flag is meaningful only on an alias of a sensitive column`);
    }
    if (f.sensitive || isAlias) {
      // The error message names both keys.
      const who = f.sensitive ? `sensitive field "${key}"` : `field "${key}" (maps the same column as sensitive "${sensitiveKey}")`;
      // ALLOWLIST — only exact value matching and NULL checks. Substring, range
      // and comparison operators, as well as search and sorting, leak the value
      // piece by piece (see `FieldConfig.sensitive`).
      const leaking = (f.filterOperators ?? []).filter((op) => !SENSITIVE_ALLOWED_OPERATORS.has(op));
      if (leaking.length) {
        throw new Error(`${who} allows only the operators ${[...SENSITIVE_ALLOWED_OPERATORS].join(", ")} — rejected: ${leaking.join(", ")}`);
      }
      if (f.searchable) throw new Error(`${who} cannot be searchable — global search does substring matching`);
      if (f.sortable) throw new Error(`${who} cannot be sortable — sorting leaks the order of the value`);
      if (isAlias && !f.declassify && (projected.has(key) || exportedKeys.has(key))) {
        throw new Error(
          `field "${key}" maps the same column ("${String(f.column)}") as sensitive "${sensitiveKey}" and enters the projection/export — set declassify: true if you are exposing the value on purpose, otherwise remove the field from select or map it to a different column`,
        );
      }
    }
    if (f.maxOptions !== undefined && (!Number.isSafeInteger(f.maxOptions) || f.maxOptions < 1)) {
      throw new Error(`maxOptions of field "${key}" must be a positive safe integer, received: ${String(f.maxOptions)}`);
    }
    if (f.options !== undefined) {
      // The option list only feeds the enum filter; exposing the value set of a
      // sensitive column would defeat the protection against the predicate oracle.
      if (f.type !== "enum") throw new Error(`field "${key}" sets options but has type: "${f.type}" — options are meaningful only on a type: "enum" field`);
      if (f.sensitive || isAlias) throw new Error(`field "${key}" maps a sensitive column — a sensitive field cannot offer options`);
      if (!f.filterOperators?.some((op) => op === "in" || op === "notIn")) {
        throw new Error(`field "${key}" sets options but its filterOperators do not include "in" or "notIn" — options are used only by the filter of those operators`);
      }
      if (typeof f.options !== "function") {
        const problem = optionsShapeProblem(f.options);
        if (problem) throw new Error(`options of field "${key}" ${problem}`);
        const maxOptions = f.maxOptions ?? DEFAULT_MAX_OPTIONS;
        if (f.options.length > maxOptions) throw new Error(`options of field "${key}" contain ${f.options.length} items; maxOptions is ${maxOptions}`);
      }
    }
    if (f.searchable && f.type !== "text") {
      // PostgreSQL ILIKE fails on a non-text column — a wrong config must not reach production.
      throw new Error(`searchable field "${key}" must have type: "text"`);
    }
    // The FILTER-side counterpart of the same ILIKE type error. If only
    // `searchable` were checked, a `type: "number"` field carrying
    // `filterOperators: ["contains"]` would silently pass boot, and the first
    // request would compile `"id" ilike $1` and produce a 500 in PostgreSQL.
    // Zod already forces the value to be a `string`; what must be checked is
    // the type of the FIELD.
    const textOperators = (f.filterOperators ?? []).filter((op) => TEXT_OPERATORS.has(op));
    if (textOperators.length && f.type !== "text") {
      throw new Error(
        `filterOperators of field "${key}" include a text operator (${textOperators.join(", ")}) but the field has type: "${f.type}" — ILIKE fails on a non-text column, so the type must be "text"`,
      );
    }
  }

  assertValidExportConfig(config);
  validated.add(config);
}

/** Boot-time rules for the `export` block. */
function assertValidExportConfig<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(config: DataTableEndpointConfig<DB, TB, Ctx>): void {
  if (config.export === undefined) return;
  if (!config.export || typeof config.export !== "object") throw new Error("export must be an object (use `{}` for the defaults)");
  const resolved = resolveExportConfig(config)!;
  const projected = new Set(projectedKeys(config));
  if (!Array.isArray(resolved.fields) || !resolved.fields.length) throw new Error("export.fields must include at least one field");
  for (const key of resolved.fields) {
    // The projection already excludes sensitive fields; the export cannot be wider than it.
    if (!projected.has(key)) {
      throw new Error(`export.fields key "${key}" is not in the projection (select, or the non-sensitive fields) — the export cannot be wider than what is visible`);
    }
  }
  const formats: unknown = config.export.formats ?? ["csv"];
  if (!Array.isArray(formats) || !formats.length) throw new Error("export.formats must include at least one format");
  for (const format of formats) {
    if (!SERVER_EXPORT_FORMATS.includes(format)) throw new Error(`export.formats contains an unknown format: ${String(format)} (allowed: ${SERVER_EXPORT_FORMATS.join(", ")})`);
  }
  if (new Set(formats).size !== formats.length) throw new Error("export.formats contains the same format more than once");
  const configuredMaxRows = config.export.maxRows;
  if (configuredMaxRows !== null && typeof configuredMaxRows === "object") {
    for (const key of Object.keys(configuredMaxRows)) {
      if (!SERVER_EXPORT_FORMATS.includes(key as never)) throw new Error(`export.maxRows contains an unknown format key: ${key}`);
    }
  }
  const integers: Array<[string, number | undefined]> = [
    ...Object.entries(resolved.maxRows).map(([format, value]): [string, number] => [`maxRows.${format}`, value]),
    ["maxSelectedKeys", resolved.maxSelectedKeys],
    ["maxConcurrent", resolved.maxConcurrent],
    ["ticketTtlMs", resolved.ticketTtlMs],
    ["batchSize", resolved.batchSize],
    ["statementTimeoutMs", resolved.statementTimeoutMs],
    ["idleTimeoutMs", resolved.idleTimeoutMs],
  ];
  for (const [key, value] of integers) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`export.${key} must be a positive safe integer, received: ${String(value)}`);
  }
  // `Infinity` disables the limit. A finite value goes to a timer: `setTimeout` reduces anything above 2^31-1 ms
  // to 1 ms, so someone who wrote "25 days" would see their export cut off immediately.
  const maxDurationMs = resolved.maxDurationMs;
  if (maxDurationMs !== Infinity && (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > MAX_TIMER_MS)) {
    throw new Error(`export.maxDurationMs must be an integer between 1 and ${MAX_TIMER_MS}, or Infinity (unlimited), received: ${String(maxDurationMs)}`);
  }
  if (resolved.maxRows.excel !== undefined && resolved.maxRows.excel > EXCEL_MAX_DATA_ROWS) {
    throw new Error(`export.maxRows.excel can be at most ${EXCEL_MAX_DATA_ROWS} (an Excel sheet has 1,048,576 rows, one of them the header), received: ${resolved.maxRows.excel}`);
  }
  if (resolved.formats.includes("pdf")) {
    const font = config.export.pdf?.font;
    const isFontSource = (value: unknown) => (typeof value === "string" && value.length > 0) || value instanceof Uint8Array;
    if (!font || !isFontSource(font.regular) || (font.bold !== undefined && !isFontSource(font.bold))) {
      throw new Error("export.formats includes \"pdf\" but export.pdf.font.regular is missing — the built-in PDF fonts do not include Turkish characters; provide a TTF/OTF/WOFF file");
    }
  }
  for (const format of resolved.formats) assertExportPackageInstalled(format);
  const store = config.export.ticketStore;
  if (store !== undefined && (typeof store !== "object" || store === null || typeof store.set !== "function" || typeof store.take !== "function")) {
    throw new Error("export.ticketStore must provide set(id, data, ttlMs) and take(id) functions");
  }
  for (const key of ["authorize", "formatter", "onExport"] as const) {
    const value = config.export[key];
    if (value !== undefined && typeof value !== "function") throw new Error(`export.${key} must be a function, received: ${typeof value}`);
  }
}
