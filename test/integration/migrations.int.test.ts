// Migrations round trip on a fresh database: latest → down to none → latest again.
// Each run creates its own throwaway database, so the development database is never touched.

import { sql, type Kysely } from "kysely";
import { NO_MIGRATIONS } from "kysely/migration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import { createMigrator } from "../../src/db/migrate.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

let testDb: TestDatabase;
let db: Kysely<Database>;

async function appliedMigrations(): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db);
  return rows.rows.map((r) => r.name);
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }>`select to_regclass(${name}) is not null as exists`.execute(db);
  return rows.rows[0]?.exists ?? false;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: false });
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.drop();
});

describe("migrations", () => {
  it("migrate to latest on an empty database applies every migration", async () => {
    const result = await createMigrator(db).migrateToLatest();
    expect(result.error).toBeUndefined();
    expect(result.results?.map((r) => [r.migrationName, r.status])).toEqual([
      ["0000_baseline", "Success"],
      ["0001_interactions", "Success"],
    ]);
    expect(await appliedMigrations()).toEqual(["0000_baseline", "0001_interactions"]);
  });

  it("creates interactions with defaults: uuidv7 id, status received, timestamps", async () => {
    const row = await db
      .insertInto("interactions")
      .values({ channel: "email", language: null, raw_text: "Dobrý den" })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(row.status).toBe("received");
    expect(row.external_id).toBeNull();
    expect(row.received_at).toBeInstanceOf(Date);
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it.each([
    ["channel", sql`insert into interactions (channel, raw_text) values ('fax', 'x')`],
    ["language", sql`insert into interactions (channel, language, raw_text) values ('chat', 'de', 'x')`],
    ["status", sql`insert into interactions (channel, raw_text, status) values ('chat', 'x', 'done')`],
    ["raw_text", sql`insert into interactions (channel, raw_text) values ('chat', E' \\n\\t ')`],
  ])("rejects an invalid %s", async (column, statement) => {
    await expect(statement.execute(db)).rejects.toThrow(`interactions_${column}_check`);
  });

  it("allows many rows without external_id but rejects a duplicate one", async () => {
    await db
      .insertInto("interactions")
      .values([
        { channel: "chat", raw_text: "a" },
        { channel: "chat", raw_text: "b", external_id: "x-1" },
      ])
      .execute();
    await expect(
      db.insertInto("interactions").values({ channel: "chat", raw_text: "c", external_id: "x-1" }).execute(),
    ).rejects.toThrow(/unique/);
  });

  it("rolls back to no migrations and drops the table", async () => {
    const result = await createMigrator(db).migrateTo(NO_MIGRATIONS);
    expect(result.error).toBeUndefined();
    expect(result.results?.every((r) => r.status === "Success" && r.direction === "Down")).toBe(true);
    expect(await appliedMigrations()).toEqual([]);
    expect(await tableExists("interactions")).toBe(false);
  });

  it("migrates to latest again", async () => {
    const result = await createMigrator(db).migrateToLatest();
    expect(result.error).toBeUndefined();
    expect(result.results?.every((r) => r.status === "Success")).toBe(true);
    expect(await tableExists("interactions")).toBe(true);
  });
});
