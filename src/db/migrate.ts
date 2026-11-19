// Migration runner: `npm run db:migrate` (to latest) and `npm run db:rollback` (one step down).
// Kysely's migrator keeps its history in the kysely_migration table and takes a database
// lock, so two runs at the same time are executed one after the other.

import { promises as fs } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { FileMigrationProvider, Migrator, type MigrationResultSet } from "kysely/migration";
import { loadDatabaseUrl } from "../config.js";
import { createDb } from "./database.js";

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function createMigrator<DB>(db: Kysely<DB>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: MIGRATIONS_DIR }),
  });
}

/** Names of the migrations in the code that the database hasn't applied, in order. Reads only. */
export async function pendingMigrations<DB>(db: Kysely<DB>): Promise<string[]> {
  const migrations = await createMigrator(db).getMigrations();
  return migrations.filter((m) => m.executedAt === undefined).map((m) => m.name);
}

/**
 * A readable error for a database that is behind the code, or null when it is current. Commands
 * call this first, so an unapplied migration reads "run npm run db:migrate", not "relation ...
 * does not exist" (P09).
 */
export async function schemaBehindMessage<DB>(db: Kysely<DB>): Promise<string | null> {
  const pending = await pendingMigrations(db);
  if (pending.length === 0) return null;
  const list = pending.join(", ");
  return (
    `The database is behind the code: migration${pending.length > 1 ? "s" : ""} ${list} ` +
    `${pending.length > 1 ? "are" : "is"} not applied. ` +
    "Run `npm run db:migrate` (or `docker compose up -d --wait --build`), then try again."
  );
}

/** Prints one line per migration; returns false if the run failed. */
export function report(result: MigrationResultSet, log: (line: string) => void = console.log): boolean {
  for (const r of result.results ?? [])
    log(`${r.status.padEnd(9)} ${r.direction.toLowerCase().padEnd(4)} ${r.migrationName}`);
  if (result.results?.length === 0) log("Nothing to do.");
  if (result.error) {
    log(`Migration failed: ${result.error instanceof Error ? result.error.message : inspect(result.error)}`);
    return false;
  }
  return true;
}

async function main(command: string | undefined): Promise<number> {
  if (command !== "latest" && command !== "down") {
    console.error("Usage: migrate.ts latest|down");
    return 2;
  }
  const db = createDb(loadDatabaseUrl());
  try {
    const migrator = createMigrator(db);
    const result = command === "latest" ? await migrator.migrateToLatest() : await migrator.migrateDown();
    return report(result) ? 0 : 1;
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
