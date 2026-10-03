import { CompiledQuery, DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { DatabaseConnection, Driver, QueryResult } from "kysely";

/** Test DB schema: a reduced version of the `access_logs_view` example. */
export interface TestDB {
  access_logs: {
    id: number;
    access_date: string;
    stadium_name: string;
    nationalId: string;
    deleted_at: string | null;
    /** For the type validation tests: `boolean`/`enum` field examples. */
    active: boolean;
    status: string;
  };
}

const dialectParts = {
  createAdapter: () => new PostgresAdapter(),
  createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
  createQueryCompiler: () => new PostgresQueryCompiler(),
};

/**
 * Only for COMPILING SQL: a real connection is never opened. `DummyDriver`
 * executes nothing, and tests assert whitelist, operator and escape behavior
 * on the `{ sql, parameters }` that `.compile()` produces.
 */
export function compileOnlyDb<DB = TestDB>(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: { ...dialectParts, createDriver: () => new DummyDriver() },
  });
}

export interface RecordedQuery {
  sql: string;
  parameters: readonly unknown[];
}

/**
 * For testing the orchestration of `handleDataTableQuery` end to end (which
 * queries are sent in which order, `LIMIT`/`OFFSET`, `skipCount`, projection)
 * without a real PostgreSQL connection: `respond` looks at the compiled SQL of
 * every `executeQuery` call and returns simulated rows. Filter and operator
 * correctness is verified separately in `filterExpression.test.ts` at the SQL
 * compilation level; no real WHERE evaluation is done here.
 */
export function fakeExecutableDb<DB = TestDB>(
  /** If it returns a Promise, the query takes until that resolves (like a slow COUNT). */
  respond: (q: RecordedQuery) => unknown[] | Promise<unknown[]>,
  options: {
    /**
     * If given, `streamQuery` returns these rows in batches of `chunkSize`; if not, streaming is unsupported (like a dialect without a cursor).
     * If it returns a Promise, the first batch does not arrive until it resolves (a slow first cursor read).
     */
    stream?: (q: RecordedQuery) => unknown[] | Promise<unknown[]>;
    /** If given, every transaction start waits for it, to test deterministically how requests arriving while a start is in progress behave (concurrency). */
    beforeBegin?: () => Promise<void>;
  } = {},
) {
  const calls: RecordedQuery[] = [];
  /** Transaction lifecycle: `begin:<isolation>:<access>`, `commit`, `rollback`, `stream-closed`. */
  const events: string[] = [];
  /** The number of rows read from the cursor, for backpressure tests. */
  const streamed = { rows: 0 };

  const connection: DatabaseConnection = {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const recorded: RecordedQuery = { sql: compiledQuery.sql, parameters: compiledQuery.parameters };
      calls.push(recorded);
      return { rows: (await respond(recorded)) as R[] };
    },
    streamQuery<R>(compiledQuery: CompiledQuery, chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
      const stream = options.stream;
      if (!stream) {
        throw new Error("'cursor' is not present in your postgres dialect config. It's required to make streaming work in postgres.");
      }
      const recorded: RecordedQuery = { sql: compiledQuery.sql, parameters: compiledQuery.parameters };
      calls.push(recorded);
      const size = chunkSize ?? 100;
      const loadRows = stream; // A `function*` declaration is hoisted, so it does not see the narrowing
      async function* generate() {
        try {
          const rows = (await loadRows(recorded)) as R[];
          for (let i = 0; i < rows.length; i += size) {
            const chunk = rows.slice(i, i + size);
            streamed.rows += chunk.length;
            yield { rows: chunk };
          }
        } finally {
          events.push("stream-closed");
        }
      }
      return generate();
    },
  };

  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction(_connection, settings) {
      await options.beforeBegin?.();
      events.push(`begin:${settings.isolationLevel ?? "-"}:${settings.accessMode ?? "-"}`);
    },
    async commitTransaction() {
      events.push("commit");
    },
    async rollbackTransaction() {
      events.push("rollback");
    },
    async releaseConnection() {},
    async destroy() {},
  };

  const db = new Kysely<DB>({ dialect: { ...dialectParts, createDriver: () => driver } });
  return { db, calls, events, streamed };
}
