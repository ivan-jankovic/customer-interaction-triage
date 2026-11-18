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
      // pool.end() resolves before the server has closed every connection. Dropping "with (force)"
      // at that moment terminates connections the client is still closing, which pg reports as
      // unhandled errors (seen in CI with the API test's parallel connections). So wait until the
      // server shows none, and keep "force" only as the fallback after 5 seconds.
      for (let waited = 0; waited < 5_000; waited += 50) {
        const r = await sql<{ n: string }>`
          select count(*) as n from pg_stat_activity where datname = ${name}`.execute(admin);
        if (Number(r.rows[0]?.n) === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    },
  };
}
