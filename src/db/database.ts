import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

/**
 * Table types for Kysely. Empty until P02 adds the first table; each phase adds the
 * tables it owns together with their migration.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by later phases
export interface Database {}

export function createDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });
}
