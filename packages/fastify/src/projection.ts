import type { DataTableServerExportFormat } from "@datatablex/core";
import type { BaseCtx, DataTableEndpointConfig } from "./types.js";

/**
 * Returns the keys of the projection. When `select` is not given, the default
 * projection is all of `fields` EXCEPT `sensitive` fields (see
 * `FieldConfig.sensitive`). A sensitive field in an explicit `select` is
 * already rejected at boot time. `primaryKey` is always included.
 */
export function projectedKeys<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(config: DataTableEndpointConfig<DB, TB, Ctx>): string[] {
  const { fields, primaryKey } = config;
  const defaultKeys = Object.keys(fields).filter((key) => !fields[key]!.sensitive);
  return Array.from(new Set([primaryKey, ...(config.select ?? defaultKeys)]));
}

/** The export options of an endpoint with every default applied; see `resolveExportConfig`. */
export interface ResolvedExportConfig {
  /**
   * Fields that can be exported.
   *
   * @default the default projection (see `projectedKeys`)
   */
  fields: string[];
  /**
   * Enabled export formats.
   *
   * @default ["csv"]
   */
  formats: DataTableServerExportFormat[];
  /** Row ceilings of the enabled formats only. */
  maxRows: Partial<Record<DataTableServerExportFormat, number>>;
  /**
   * Maximum number of primary keys in a single request in the `selected` scope.
   *
   * @default 10000
   */
  maxSelectedKeys: number;
  /**
   * Maximum number of exports that are opening or streaming at once, per process and per endpoint.
   *
   * @default 4
   */
  maxConcurrent: number;
  /**
   * Lifetime of a download ticket, in milliseconds.
   *
   * @default 60000
   */
  ticketTtlMs: number;
  /**
   * Number of rows read from the cursor in each batch.
   *
   * @default 1000
   */
  batchSize: number;
  /** Statement timeout applied to the export transaction, in milliseconds; `undefined` when not configured. */
  statementTimeoutMs: number | undefined;
  /**
   * How long the export waits for the consumer to read before it is cut, in milliseconds.
   *
   * @default 60000
   */
  idleTimeoutMs: number;
  /**
   * Maximum total duration of the export (including opening), in milliseconds. `Infinity`: no time limit.
   *
   * @default 600000
   */
  maxDurationMs: number;
}

/** The export formats that the server can produce. */

export const SERVER_EXPORT_FORMATS: readonly DataTableServerExportFormat[] = ["csv", "excel", "pdf"];
/** Default row ceiling of each enabled format. */
export const DEFAULT_EXPORT_MAX_ROWS = 100_000;
/** Default maximum number of primary keys in a single `selected`-scope export request. */
export const DEFAULT_EXPORT_MAX_SELECTED_KEYS = 10_000;
/** Default number of rows read from the cursor in each batch. */
export const DEFAULT_EXPORT_BATCH_SIZE = 1000;
/** Default maximum number of concurrent exports per process and endpoint. */
export const DEFAULT_EXPORT_MAX_CONCURRENT = 4;
/** Default lifetime of a download ticket, in milliseconds. */
export const DEFAULT_EXPORT_TICKET_TTL_MS = 60_000;
/** If the consumer does not read for this long, the export is cut; the transaction and the connection do not stay tied to a client's speed indefinitely. */
export const DEFAULT_EXPORT_IDLE_TIMEOUT_MS = 60_000;
/**
 * Default total duration of an export (including opening). Files produced with
 * the default `maxRows` (100,000) stay far below it; the limit bounds the
 * lifetime of the REPEATABLE READ snapshot that stays open (VACUUM, migration
 * locks). Whoever raises `maxRows` should raise `maxDurationMs` too.
 */
export const DEFAULT_EXPORT_MAX_DURATION_MS = 10 * 60_000;
/** The largest delay that `setTimeout` accepts without overflowing; a larger delay falls back to 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;
/** Excel's worksheet limit is 1,048,576 rows; one of them is the header row, which leaves this many data rows. */
export const EXCEL_MAX_DATA_ROWS = 1_048_575;

/** The single source of the export defaults — the boot rules, the meta and the handler read the same values. Returns `null` when there is no `export`. */
export function resolveExportConfig<DB, TB extends keyof DB & string, Ctx extends BaseCtx>(
  config: DataTableEndpointConfig<DB, TB, Ctx>,
): ResolvedExportConfig | null {
  if (!config.export) return null;
  const formats = config.export.formats ?? ["csv"];
  const configured = config.export.maxRows;
  const maxRows: Partial<Record<DataTableServerExportFormat, number>> = {};
  for (const format of formats) {
    maxRows[format] = typeof configured === "object" && configured !== null ? (configured[format] ?? DEFAULT_EXPORT_MAX_ROWS) : (configured ?? DEFAULT_EXPORT_MAX_ROWS);
  }
  return {
    fields: config.export.fields ?? projectedKeys(config),
    formats,
    maxRows,
    maxSelectedKeys: config.export.maxSelectedKeys ?? DEFAULT_EXPORT_MAX_SELECTED_KEYS,
    maxConcurrent: config.export.maxConcurrent ?? DEFAULT_EXPORT_MAX_CONCURRENT,
    ticketTtlMs: config.export.ticketTtlMs ?? DEFAULT_EXPORT_TICKET_TTL_MS,
    batchSize: config.export.batchSize ?? DEFAULT_EXPORT_BATCH_SIZE,
    statementTimeoutMs: config.export.statementTimeoutMs,
    idleTimeoutMs: config.export.idleTimeoutMs ?? DEFAULT_EXPORT_IDLE_TIMEOUT_MS,
    maxDurationMs: config.export.maxDurationMs ?? DEFAULT_EXPORT_MAX_DURATION_MS,
  };
}
