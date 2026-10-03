import { DATATABLEX_PROTOCOL_VERSION } from "@datatablex/core";
import type { DataTableEndpointExportMeta, DataTableEndpointFieldMeta, DataTableEndpointMeta } from "@datatablex/core";
import type { BaseCtx, DataTableEndpointConfig } from "./types.js";
import { resolveLimits } from "./limits.js";
import { assertValidEndpointConfig } from "./config.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.js";
import { resolveExportConfig } from "./projection.js";
import type { ResolvedExportConfig } from "./projection.js";

/** The enabled formats and their row ceilings in a single field (`formats`). */
function exportMeta(resolved: ResolvedExportConfig): DataTableEndpointExportMeta {
  return { formats: { ...resolved.maxRows }, fields: [...resolved.fields] };
}

/**
 * Builds, from an endpoint config, the meta description that can be exposed to
 * the client. It is a pure function; the `meta` handler of `datatableRoute`
 * calls it once at boot time.
 *
 * Deliberately LEFT OUT: the DB `column` mapping, `parseValue`, `select`, the
 * `sensitive` flag, and the option list itself (it is user-specific; the meta
 * only reports `hasOptions`). A sensitive field is still listed — that is the
 * information the client needs in order to offer only the allowed operators
 * (`eq`/`in`/...), and the existence of the field can be inferred from request
 * errors anyway.
 *
 * @example
 * ```ts
 * const meta = describeDataTableEndpoint(config);
 * meta.fields.status.filterOperators; // ["eq", "in"]
 * meta.limits.maxPageSize; // 500
 * ```
 *
 * @throws {Error} When the config is invalid (see `assertValidEndpointConfig`).
 */
export function describeDataTableEndpoint<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  config: DataTableEndpointConfig<DB, TB, Ctx>,
): DataTableEndpointMeta {
  assertValidEndpointConfig(config);
  const { maxOffset, ...limits } = resolveLimits(config);
  const exportConfig = resolveExportConfig(config);
  const fields: Record<string, DataTableEndpointFieldMeta> = {};
  for (const [key, field] of Object.entries(config.fields)) {
    fields[key] = {
      type: field.type,
      filterOperators: [...(field.filterOperators ?? [])],
      sortable: Boolean(field.sortable),
      searchable: Boolean(field.searchable),
      ...(field.options !== undefined ? { hasOptions: true } : null),
    };
  }
  return {
    version: 1,
    protocol: { version: DATATABLEX_PROTOCOL_VERSION, supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
    primaryKey: config.primaryKey, limits: { ...limits, maxOffset: maxOffset ?? null },
    fields,
    ...(exportConfig ? { export: exportMeta(exportConfig) } : null),
  };
}
