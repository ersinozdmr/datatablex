import { fileURLToPath } from "node:url";
import type { FastifyRequest } from "fastify";
import type { BaseCtx, DataTableEndpointConfig, FieldConfig } from "@datatablex/fastify";
import type { ExampleDB } from "./schema.js";

/**
 * The base context shape (`BaseCtx`) is not extended here: the example does
 * NOT include JWT verification (authentication is out of scope for it).
 * `getContext` returns a fixed context and `authorize` only checks the roles
 * of that context; in a real integration both derive from the verified output
 * of the request's `preHandler`.
 *
 * The one exception is the role: the `x-demo-role: admin` header adds
 * `"admin"` to `roles` for DEMO purposes. It does NOT replace a real JWT or
 * session system; it only makes the field-level authorization that the
 * `accessLogsConfig`/`accessLogsAdminConfig` pair demonstrates (masking of the
 * national ID number) triggerable from the browser (see the role routing in
 * `index.ts` and the role selector in `AccessLogsScreen.tsx`).
 */
function resolveRoles(req: FastifyRequest): string[] {
  const roles = ["access_logs:read"];
  if (req.headers["x-demo-role"] === "admin") roles.push("admin");
  return roles;
}

export type ExampleCtx = BaseCtx;

/**
 * Works on `access_logs_view`, NOT on the raw table (see
 * `migrations/0001_init.ts`).
 *
 * The raw `nationalId` field is open to exact matches (`eq`) ONLY, through
 * `sensitive: true`: an operator can find a record with a complete national ID
 * number they already hold (the last 4 digits can collide across several
 * records), but cannot learn the value piece by piece. If the field were open
 * to a `contains` filter or to the global search, then even without being in
 * the projection the question "did the query return a row?" would give away
 * every digit in about 10 requests (a predicate oracle). The `sensitive` flag
 * enforces this at the library level: `contains`, range and `in` operators,
 * `searchable`, `sortable` and being part of the projection are rejected at
 * boot time; a query can contain at most ONE sensitive `eq`, and it must be a
 * direct child of the root `AND` (one guess per request).
 *
 * The `column` mapping of the `nationalIdMasked` field DIFFERS between the two
 * configurations (the `national_id_masked` view column for the operator, the
 * raw `national_id` column for the admin). The wire field name
 * ("nationalIdMasked") stays the same and the DISPLAYED VALUE changes with the
 * role. This makes field-level authorization possible without any role-specific
 * branching on the client (same column, same response shape).
 */
const sharedFields = {
  id: { column: "id", type: "number", filterOperators: ["eq", "in"] },
  accessDate: {
    column: "access_date",
    type: "datetime",
    sortable: true,
    // `lt` is included because the react package sends a two-sided range
    // filter on `datetime` columns as a `gte` + `lt` AND group, not as
    // `between` (see packages/react/src/state/filters.ts), to avoid losing
    // microsecond precision. `lte` and `between` are still allowed for
    // one-sided upper bounds and for other clients.
    filterOperators: ["gte", "lt", "lte", "between", "isNull"],
  },
  visitDay: {
    column: "visit_day",
    type: "date",
    sortable: true,
    filterOperators: ["gte", "lte", "between"],
  },
  stadiumName: {
    column: "stadium_name",
    type: "text",
    sortable: true,
    filterOperators: ["eq", "contains", "notContains"],
    // The ONLY searchable field; its pg_trgm GIN index is created in migrations/0001_init.ts.
    // When the search ORs several fields, a single branch without an index is
    // enough to push the whole search to a sequential scan.
    searchable: true,
  },
  ticketPrice: {
    column: "ticket_price",
    type: "number",
    sortable: true,
    filterOperators: ["gte", "lte", "between"],
  },
  // Filter options come from the server: the client column does not set `options`, the list
  // is read from the `/query/options/status` route. The resolver receives `ctx`; in a real
  // application a table query filtered by tenant or role would run here. The package does not cache the result.
  status: {
    column: "status",
    type: "enum",
    filterOperators: ["eq", "in"],
    options: () => Object.entries(STATUS_LABELS).map(([value, label]) => ({ label, value })),
  },
  active: { column: "active", type: "boolean", filterOperators: ["eq"] },
  // The filter box of the "National ID" column targets this field (see AccessLogsScreen.tsx:
  // `key: "nationalId"`, `filterOperators: ["eq"]`; the displayed value comes from `nationalIdMasked`).
  // A btree index serves the exact match: see migrations/0001_init.ts.
  nationalId: { column: "national_id", type: "text", sensitive: true, filterOperators: ["eq"] },
} satisfies Record<string, FieldConfig<ExampleDB, "access_logs_view">>;

const select = ["id", "accessDate", "visitDay", "stadiumName", "ticketPrice", "status", "active", "nationalIdMasked"];

/** Status labels: both the export formatter and the filter options of the `status` field derive from this. */
const STATUS_LABELS: Record<string, string> = { open: "Open", closed: "Closed", pending: "Pending" };

/** The built-in fonts of PDF contain no Turkish characters; see assets/fonts/README.md. */
const font = (name: string) => fileURLToPath(new URL(`../../assets/fonts/${name}`, import.meta.url));

/**
 * Server-side export: CSV, XLSX and PDF are produced on the server as a
 * stream and arrive through the browser's own download. Even the masked
 * national ID number is not written to the file: the server counterpart of the
 * client's `exportable: false` is the `fields` list, and only this is a real
 * boundary. The labels produce the same text as the client's `exportValue`.
 */
const exportConfig: DataTableEndpointConfig<ExampleDB, "access_logs_view", ExampleCtx>["export"] = {
  fields: select.filter((key) => key !== "nationalIdMasked"),
  formats: ["csv", "excel", "pdf"],
  // The package default is 100 000 for every format. These values are the measurement and benchmark
  // targets of THIS EXAMPLE (see scripts/bench-export.ts), NOT defaults to copy: in your own project set
  // them according to the size of your table, the capacity of your database and `maxConcurrent`.
  maxRows: { csv: 10_000_000, excel: 1_000_000, pdf: 100_000 },
  // The package default is 10 minutes and was chosen for the default of 100 000 rows. A CSV of 10M rows
  // (~1.5 GB) downloads in ~10 minutes at 20 Mbps: a large `maxRows` calls for a larger duration too.
  maxDurationMs: 30 * 60_000,
  pdf: { font: { regular: font("Roboto-Regular.ttf"), bold: font("Roboto-Medium.ttf") } },
  statementTimeoutMs: 60_000,
  formatter: (field, value) => {
    if (field === "status") return STATUS_LABELS[String(value)] ?? value;
    if (field === "active") return value ? "Active" : "Inactive";
    return value;
  },
  // Audit: in a real integration this is written to a durable record. The event carries the query, and the
  // query can contain the value searched on a sensitive field (the national ID number); here only counts
  // are logged, filter values are not written.
  onExport: (event) => {
    console.info(
      `[example] export ${event.outcome}: user=${event.ctx.userId} rows=${event.rowCount}/${event.total} fields=${event.fields.join(",")} duration=${event.durationMs}ms`,
    );
  },
};

export const accessLogsConfig: DataTableEndpointConfig<ExampleDB, "access_logs_view", ExampleCtx> = {
  table: "access_logs_view",
  primaryKey: "id",
  fields: {
    ...sharedFields,
    nationalIdMasked: { column: "national_id_masked", type: "text" }, // masked view — filterOperators not set
  },
  select,
  getContext: async (req) => ({ userId: "example-user", roles: resolveRoles(req) }),
  scope: (eb) => eb("deleted_at", "is", null), // soft-delete scope
  authorize: (ctx) => ctx.roles.includes("access_logs:read"),
  maxPageSize: 500,
  export: exportConfig,
};

/**
 * Same table, same wire shape; the ONLY difference is that `nationalIdMasked`
 * is mapped to the raw `national_id` column. `authorize` DELIBERATELY checks
 * the role produced by `resolveRoles` AGAIN (it does not trust the role
 * routing in `index.ts`). This is the same principle as the package treating
 * `scope` as a defense layer: even if there were a bug in the routing logic,
 * this `authorize` call steps in with a 403.
 */
export const accessLogsAdminConfig: DataTableEndpointConfig<ExampleDB, "access_logs_view", ExampleCtx> = {
  ...accessLogsConfig,
  fields: {
    ...sharedFields,
    // Unmasked view; the wire field name stays the same. Because the raw `national_id` column is `sensitive`,
    // letting this alias into the projection must be a DELIBERATE opening: `declassify: true`.
    // An operator can query the full national ID number only with `eq` and with ONE guess per request
    // (a single sensitive leaf in the root AND); this role already sees the value.
    // In your own project give the alias only to the role that really needs to see the value.
    nationalIdMasked: { column: "national_id", type: "text", declassify: true },
  },
  authorize: (ctx) => ctx.roles.includes("access_logs:read") && ctx.roles.includes("admin"),
};
