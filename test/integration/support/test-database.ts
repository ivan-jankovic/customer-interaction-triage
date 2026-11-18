// A throwaway database per test file, so tests never touch the development database.

import { randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { loadServiceConfig } from "../../../src/config.js";
import { createDb, type Database } from "../../../src/db/database.js";
import { createMigrator } from "../../../src/db/migrate.js";

export interface TestDatabase {
  name: string;
  url: string;
  db: Kysely<Database>;
  /** Closes the connection and drops the database. */
  drop(): Promise<void>;
}

export async function createTestDatabase({ migrate }: { migrate: boolean }): Promise<TestDatabase> {
  const { databaseUrl } = loadServiceConfig();
  const name = `triage_test_${randomBytes(4).toString("hex")}`;
  const admin = createDb(databaseUrl);
  await sql`create database ${sql.id(name)}`.execute(admin);

  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());

  if (migrate) {
    const result = await createMigrator(db).migrateToLatest();
    if (result.error) throw new Error("Migrating the test database failed", { cause: result.error });
  }

  return {
    name,
    url: url.toString(),
    db,
    async drop() {
      await db.destroy();
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    },
  };
}
