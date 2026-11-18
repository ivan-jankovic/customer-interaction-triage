// Migrations round trip on a fresh database: latest → down to none → latest again.
// Each run creates its own throwaway database, so the development database is never touched.

import { randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { NO_MIGRATIONS } from "kysely/migration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServiceConfig } from "../../src/config.js";
import { createDb, type Database } from "../../src/db/database.js";
import { createMigrator } from "../../src/db/migrate.js";

const { databaseUrl } = loadServiceConfig();
const testDbName = `triage_test_${randomBytes(4).toString("hex")}`;
let admin: Kysely<Database>;
let db: Kysely<Database>;

function urlFor(database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function appliedMigrations(): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db);
  return rows.rows.map((r) => r.name);
}

beforeAll(async () => {
  admin = createDb(databaseUrl);
  await sql`create database ${sql.id(testDbName)}`.execute(admin);
  db = createDb(urlFor(testDbName));
});

afterAll(async () => {
  await db?.destroy();
  await sql`drop database if exists ${sql.id(testDbName)} with (force)`.execute(admin);
  await admin.destroy();
});

describe("migrations", () => {
  it("migrate to latest on an empty database applies the baseline", async () => {
    const result = await createMigrator(db).migrateToLatest();
    expect(result.error).toBeUndefined();
    expect(result.results?.map((r) => [r.migrationName, r.status])).toContainEqual(["0000_baseline", "Success"]);
    expect(await appliedMigrations()).toContain("0000_baseline");
  });

  it("rolls back to no migrations", async () => {
    const result = await createMigrator(db).migrateTo(NO_MIGRATIONS);
    expect(result.error).toBeUndefined();
    expect(result.results?.every((r) => r.status === "Success" && r.direction === "Down")).toBe(true);
    expect(await appliedMigrations()).toEqual([]);
  });

  it("migrates to latest again", async () => {
    const result = await createMigrator(db).migrateToLatest();
    expect(result.error).toBeUndefined();
    expect(result.results?.every((r) => r.status === "Success")).toBe(true);
    expect(await appliedMigrations()).toContain("0000_baseline");
  });
});
