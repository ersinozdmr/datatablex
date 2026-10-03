import type { BaseCtx, DataTableEndpointConfig } from "./types.js";

/** The effective query limits of an endpoint, after the defaults have been applied. */
export interface ResolvedLimits {
  /** Maximum page size. */
  maxPageSize: number;
  /** Maximum nesting depth of `FilterGroup`. */
  maxFilterDepth: number;
  /** Maximum total number of leaf filters. */
  maxFilterCount: number;
  /** Maximum number of elements in an `in`/`notIn` array. */
  maxInValues: number;
  /** Maximum character length of the `search` string. */
  maxSearchLength: number;
  /** Maximum number of elements in the `sorting` array. */
  maxSortCount: number;
  /** `undefined` = only the safe integer bound. */
  maxOffset: number | undefined;
}

/**
 * The SINGLE source of the defaults — validation, query building and the meta
 * description all read the same effective values. If `?? 500` were written
 * separately in each place, the limit the meta reports and the limit actually
 * applied could silently diverge.
 *
 * @example
 * ```ts
 * resolveLimits(config).maxPageSize; // 500 unless config.maxPageSize is set
 * ```
 */
export function resolveLimits<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  config: DataTableEndpointConfig<DB, TB, Ctx>,
): ResolvedLimits {
  return {
    maxPageSize: config.maxPageSize ?? 500,
    maxFilterDepth: config.maxFilterDepth ?? 3,
    maxFilterCount: config.maxFilterCount ?? 50,
    maxInValues: config.maxInValues ?? 500,
    maxSearchLength: config.maxSearchLength ?? 200,
    maxSortCount: config.maxSortCount ?? 3,
    maxOffset: config.maxOffset,
  };
}

/** `maxOffset` may be 0 (first page only); a 0 for any of the others would make the endpoint unusable. */
const LIMIT_MINIMUMS: Record<keyof ResolvedLimits, number> = {
  maxPageSize: 1,
  maxFilterDepth: 1,
  maxFilterCount: 1,
  maxInValues: 1,
  maxSearchLength: 1,
  maxSortCount: 1,
  maxOffset: 0,
};

/**
 * Boot-time check — ALL the limits must be safe integers and at or above their
 * lower bound. If only `maxOffset` were checked, `maxPageSize: 0` or `NaN`
 * would pass boot and make the page size meaningless in the handler.
 *
 * @throws {Error} When a limit is not a safe integer or is below its minimum
 * (1, or 0 for `maxOffset`).
 */
export function validateLimits(limits: ResolvedLimits): void {
  for (const [key, min] of Object.entries(LIMIT_MINIMUMS) as Array<[keyof ResolvedLimits, number]>) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < min) {
      const expected = min === 0 ? "non-negative" : "positive";
      throw new Error(`${key} must be a ${expected} safe integer, received: ${String(value)}`);
    }
  }
}
