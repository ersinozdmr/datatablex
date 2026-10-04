import "dotenv/config";
import { sql, type Insertable } from "kysely";
import { createDb } from "../src/server/db.js";
import type { AccessLogsTable } from "../src/server/schema.js";

/**
 * What the seed data has to provide:
 * - Volume for pagination (~50,000 rows).
 * - Text fields with Turkish characters (for URL round-trip and ILIKE collation tests).
 * - At least one row that carries a formula injection (a `stadiumName` starting with `=cmd|`,
 *   CWE-1236).
 * - A filter combination that forces a multi-page CSV export:
 *   the `status = "open"` rows are weighted so that they ALONE exceed 10,000.
 */
const TOTAL_ROWS = 50_000;
const BATCH_SIZE = 1_000;

/**
 * A PRNG with a fixed seed (mulberry32): the e2e scenarios see the SAME data
 * set on every run. With `Math.random` every seed would produce a different
 * table, and whether a test passed could depend on the data. Timestamps are
 * also generated relative to a fixed reference moment, not relative to
 * `Date.now()`.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20260924);
const REFERENCE_NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

/**
 * The KNOWN national ID number searched for in the e2e exact-match scenario (the same value as in e2e/access-logs.spec.ts).
 * The randomly generated national ID numbers (see `randomNationalId`) have 11 digits and the first digit is 1-9; even if this value
 * collided with one of them (probability ~1e-6), the test also verifies the stadium name of the returned row.
 */
const KNOWN_NATIONAL_ID = "10000000146";

/** A unique stadium name, findable by search, used for the day-boundary regression. */
const BOUNDARY_STADIUM = "Mikrosaniye Sınır Kaydı";

// Real stadium names with Turkish characters, for URL round-trip and ILIKE/pg_trgm tests.
const STADIUM_NAMES = [
  "Türk Telekom Stadyumu",
  "Vodafone Park",
  "Şükrü Saracoğlu Stadyumu",
  "Atatürk Olimpiyat Stadyumu",
  "Gürsel Aksel Stadyumu",
  "Yeni Adana Stadyumu",
  "Konya Büyükşehir Belediyesi Stadyumu",
  "Kadir Has Stadyumu",
  "Papara Park",
  "Çaykur Didi Stadyumu",
  "Timsah Arena",
  "Sivas 4 Eylül Stadyumu",
];

const STATUSES = ["open", "closed", "pending"] as const;

function randomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function randomNationalId(): string {
  let digits = String(randomInt(1, 9)); // the first digit cannot be 0
  for (let i = 0; i < 10; i++) digits += String(randomInt(0, 9));
  return digits;
}

/** About 60% of `status` is "open": a deliberate weighting to force the multi-page export scenario. */
function randomStatus(): (typeof STATUSES)[number] {
  const roll = random();
  if (roll < 0.6) return STATUSES[0];
  if (roll < 0.85) return STATUSES[1];
  return STATUSES[2];
}

function randomAccessDate(): Date {
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
  return new Date(REFERENCE_NOW - randomInt(0, twoYearsMs));
}

const istanbulDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * `visit_day` is the calendar day of the access in ISTANBUL: the screen shows
 * `accessDate` in `Europe/Istanbul`, so the UTC day (`toISOString().slice(0,10)`)
 * would be one day behind for accesses after 21:00Z.
 */
function toDateOnly(date: Date): string {
  return istanbulDay.format(date);
}

function randomRow(index: number): Omit<Insertable<AccessLogsTable>, "id"> {
  const accessDate = randomAccessDate();
  return {
    access_date: accessDate,
    visit_day: toDateOnly(accessDate),
    stadium_name: STADIUM_NAMES[index % STADIUM_NAMES.length]!,
    national_id: randomNationalId(),
    ticket_price: randomInt(50, 750),
    status: randomStatus(),
    active: random() < 0.85,
    deleted_at: null,
  };
}

/**
 * The seed runs `TRUNCATE` on the target table: with a wrong `DATABASE_URL`
 * the data loss is irreversible. It runs unconditionally only on the
 * example's own database or on a database whose name ends in `_test` or
 * `_e2e`; every other target must be confirmed explicitly with
 * `ALLOW_DESTRUCTIVE_SEED=1`.
 */
const SAFE_DATABASE_NAMES = /^(datatablex_example|.+_(test|e2e))$/;

function assertSafeSeedTarget(): void {
  const url = process.env.DATABASE_URL;
  if (!url) return; // createDb() reports the missing variable with its own message
  let database: string;
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("[seed] DATABASE_URL could not be parsed: TRUNCATE is not run without verifying the target database.");
  }
  if (SAFE_DATABASE_NAMES.test(database) || process.env.ALLOW_DESTRUCTIVE_SEED === "1") return;
  throw new Error(
    `[seed] Database "${database || "(empty)"}" is not on the safe list for the seed; access_logs would have been truncated. ` +
      "Use the example database (datatablex_example) or a database whose name ends in _test/_e2e, " +
      "or set ALLOW_DESTRUCTIVE_SEED=1 if you mean to delete the data.",
  );
}

async function main(): Promise<void> {
  assertSafeSeedTarget();
  const db = createDb();

  console.log("[seed] clearing existing rows…");
  await sql`TRUNCATE TABLE access_logs RESTART IDENTITY CASCADE`.execute(db);

  console.log(`[seed] inserting ${TOTAL_ROWS} rows (in batches of ${BATCH_SIZE})…`);
  let inserted = 0;
  while (inserted < TOTAL_ROWS) {
    const batchSize = Math.min(BATCH_SIZE, TOTAL_ROWS - inserted);
    const rows = Array.from({ length: batchSize }, (_, i) => randomRow(inserted + i));
    await db.insertInto("access_logs").values(rows).execute();
    inserted += batchSize;
    if (inserted % (BATCH_SIZE * 5) === 0 || inserted === TOTAL_ROWS) {
      console.log(`[seed] ${inserted}/${TOTAL_ROWS}`);
    }
  }

  // Formula injection (CWE-1236): the ONE row added on purpose to verify the
  // escaping layer of the export end to end.
  await db
    .insertInto("access_logs")
    .values({
      access_date: new Date(REFERENCE_NOW),
      visit_day: toDateOnly(new Date(REFERENCE_NOW)),
      stadium_name: "=cmd|' /C calc'!A0",
      national_id: randomNationalId(),
      ticket_price: 100,
      status: "open",
      active: true,
      deleted_at: null,
    })
    .execute();

  // Exact-match national ID scenario: an operator must be able to find this
  // record ONLY with the full national ID number; a partial value must return
  // no rows (see the e2e tests).
  await db
    .insertInto("access_logs")
    .values({
      access_date: new Date(REFERENCE_NOW),
      visit_day: toDateOnly(new Date(REFERENCE_NOW)),
      stadium_name: "Kimlik Tam Eşleşme Kaydı",
      national_id: KNOWN_NATIONAL_ID,
      ticket_price: 100,
      status: "open",
      active: true,
      deleted_at: null,
    })
    .execute();

  // Day-boundary regression: the timestamps are sent as strings so that
  // PostgreSQL keeps MICROSECOND precision (a JS `Date` truncates at the
  // millisecond). For 15 January 2025 in Istanbul, the day filter must include
  // the first two rows (start of day and 23:59:59.999500) and exclude the
  // third (16 January 00:00). An inclusive `23:59:59.999` upper bound would
  // miss the second row.
  for (const accessDate of ["2025-01-15 00:00:00+03", "2025-01-15 23:59:59.999500+03", "2025-01-16 00:00:00+03"]) {
    await db
      .insertInto("access_logs")
      .values({
        access_date: accessDate,
        visit_day: accessDate.slice(0, 10),
        stadium_name: BOUNDARY_STADIUM,
        national_id: randomNationalId(),
        ticket_price: 100,
        status: "closed",
        active: true,
        deleted_at: null,
      })
      .execute();
  }

  // Soft-delete example: ONE row to verify end to end that the endpoint's
  // `deleted_at IS NULL` scope condition really filters.
  await db
    .insertInto("access_logs")
    .values({
      access_date: new Date(REFERENCE_NOW),
      visit_day: toDateOnly(new Date(REFERENCE_NOW)),
      stadium_name: "Silinmiş Kayıt (görünmemeli)",
      national_id: randomNationalId(),
      ticket_price: 100,
      status: "closed",
      active: false,
      deleted_at: new Date(REFERENCE_NOW),
    })
    .execute();

  console.log("[seed] done.");
  await db.destroy();
}

main().catch((err: unknown) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
