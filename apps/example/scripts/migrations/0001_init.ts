import { sql, type Kysely } from "kysely";

/**
 * Creates the `access_logs` table, its indexes and `access_logs_view`, the view the endpoint queries.
 *
 * - `stadium_name` has a `pg_trgm` GIN index because it is searchable: the global search runs `ILIKE '%term%'`,
 *   which a btree index cannot serve.
 * - `national_id` is a sensitive value. The endpoint allows only exact matches on it, so a plain btree index is
 *   enough. The view exposes it next to `national_id_masked` (asterisks plus the last four digits): the masked
 *   column is what a regular role sees, and the raw column is what an exact-match filter and the admin role use.
 * - `deleted_at` goes through the view only so that the endpoint's row scope can filter out soft-deleted rows; it
 *   is not in the endpoint's field allowlist.
 *
 * The local Docker setup enables `pg_trgm` with an init script, but a plain PostgreSQL service (as in CI) runs no
 * init script, so the extension is created here as well.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  await db.schema
    .createTable("access_logs")
    .addColumn("id", "serial", (c) => c.primaryKey())
    .addColumn("access_date", "timestamptz", (c) => c.notNull())
    .addColumn("visit_day", "date", (c) => c.notNull())
    .addColumn("stadium_name", "text", (c) => c.notNull())
    .addColumn("national_id", "text", (c) => c.notNull())
    .addColumn("ticket_price", "integer", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("active", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("deleted_at", "timestamptz")
    .execute();

  await db.schema
    .createIndex("access_logs_stadium_name_trgm_idx")
    .on("access_logs")
    .using("gin")
    .expression(sql`stadium_name gin_trgm_ops`)
    .execute();

  await db.schema.createIndex("access_logs_access_date_idx").on("access_logs").column("access_date").execute();

  await db.schema.createIndex("access_logs_national_id_idx").on("access_logs").column("national_id").execute();

  await sql`
    CREATE VIEW access_logs_view AS
    SELECT
      id,
      access_date,
      visit_day,
      stadium_name,
      national_id,
      CONCAT(REPEAT('*', GREATEST(LENGTH(national_id) - 4, 0)), RIGHT(national_id, 4)) AS national_id_masked,
      ticket_price,
      status,
      active,
      deleted_at
    FROM access_logs
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP VIEW IF EXISTS access_logs_view`.execute(db);
  await db.schema.dropTable("access_logs").execute();
}
