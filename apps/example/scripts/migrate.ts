import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "dotenv/config";
import type { Migration, MigrationProvider } from "kysely";
import { Migrator } from "kysely";
import { promises as fs } from "node:fs";
import { createDb } from "../src/server/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationFolder = path.join(__dirname, "migrations");

/**
 * Kysely's `FileMigrationProvider` passes the file path to `import()` BARE
 * (without converting it to a file:// URL); on Windows the ESM loader rejects
 * this (`ERR_UNSUPPORTED_ESM_URL_SCHEME`, since `C:\...` is not a URL scheme).
 * This minimal provider implements the same contract (`getMigrations`) with
 * `pathToFileURL`, so it works on all three operating systems.
 */
const provider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await fs.readdir(migrationFolder)).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    const migrations: Record<string, Migration> = {};
    for (const file of files.sort()) {
      const mod = (await import(pathToFileURL(path.join(migrationFolder, file)).href)) as Migration;
      migrations[file.replace(/\.(ts|js)$/, "")] = mod;
    }
    return migrations;
  },
};

async function main(): Promise<void> {
  const db = createDb();
  const migrator = new Migrator({ db, provider });

  const direction = process.argv[2] === "down" ? "down" : "up";
  const { error, results } = direction === "down" ? await migrator.migrateDown() : await migrator.migrateToLatest();

  for (const result of results ?? []) {
    const status = result.status === "Success" ? "OK" : result.status === "Error" ? "ERROR" : "SKIPPED";
    console.log(`[migrate] ${result.migrationName} — ${status}`);
  }

  await db.destroy();

  if (error) {
    console.error("[migrate] failed:", error);
    process.exit(1);
  }
  if (!results?.length) {
    console.log(`[migrate] no migrations to apply (${direction}).`);
  }
}

main();
