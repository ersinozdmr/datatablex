import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import Cursor from "pg-cursor";
import type { ExampleDB } from "./schema.js";

/**
 * The DEFAULT parser of `node-postgres` for `date` (OID 1082) turns the value
 * into a `Date` with `new Date(year, month, day)`, using the LOCAL time zone of
 * the NODE PROCESS; when this object is serialized to JSON
 * (`Date.prototype.toJSON`) it is shifted to UTC. The result: if the server
 * runs at UTC+3, a `visit_day = 2025-01-15` field comes back in the response as
 * `"2025-01-14T21:00:00.000Z"`. That makes the contract of a `date` column
 * ("only a calendar day, NOT a moment") depend on the SERVER TIME ZONE.
 * `@datatablex/fastify` does not transform row values: it returns whatever the
 * driver gives. So it is the responsibility of EVERY `Kysely` + `pg`
 * integration to have the parser return the BARE string (`YYYY-MM-DD`, never
 * converted to a `Date`). `timestamptz` (OID 1184) does NOT have this problem:
 * it is always an absolute moment and carries no conversion ambiguity.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

function connectionString(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "[example] DATABASE_URL is not set: start Postgres with `pnpm --filter example db:up` and copy .env.example to .env.",
    );
  }
  return value;
}

export function createDb(): Kysely<ExampleDB> {
  return new Kysely<ExampleDB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: connectionString(), max: 10 }),
      // The server export streams rows through a cursor (Kysely `.stream()`);
      // with a dialect that has no cursor, the export route returns 500.
      cursor: Cursor,
    }),
  });
}
