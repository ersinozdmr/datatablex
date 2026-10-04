import type { ColumnType, Generated } from "kysely";

/**
 * `access_logs` is the real table. `deleted_at` is deliberately carried into
 * `access_logs_view` as well (see `migrations/0001_init.ts`), but it is NEVER
 * included in the endpoint's `fields`; it exists only for the soft-delete
 * condition of `scope` (see `accessLogsConfig.ts`). The view carries the masked
 * derivative `national_id_masked` (the sensitive field is masked at the view
 * level) and also the raw `national_id`, so that an operator can search with a
 * full national ID number and an admin can see it unmasked. For the operator
 * role, what protects the raw value is the `sensitive: true` field in
 * `accessLogsConfig.ts` (only `eq`, never in the projection).
 */
export interface AccessLogsTable {
  id: Generated<number>;
  access_date: ColumnType<Date, Date | string, Date | string>;
  visit_day: ColumnType<Date, Date | string, Date | string>;
  stadium_name: string;
  national_id: string;
  ticket_price: number;
  status: string;
  active: boolean;
  deleted_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface AccessLogsViewTable {
  id: number;
  access_date: ColumnType<Date, never, never>;
  visit_day: ColumnType<Date, never, never>;
  stadium_name: string;
  // For role-based search and masking (see accessLogsConfig.ts):
  // `national_id` is a `sensitive: true` field in the operator config. It is
  // filtered only with `eq`, cannot be searched or sorted, and never enters
  // any projection.
  national_id: string;
  national_id_masked: string;
  ticket_price: number;
  status: string;
  active: boolean;
  // NEVER included in the allowlist (fields); it is passed through the view
  // only so that the soft-delete condition of the scope can see this column.
  deleted_at: ColumnType<Date | null, never, never>;
}

export interface ExampleDB {
  access_logs: AccessLogsTable;
  access_logs_view: AccessLogsViewTable;
}
