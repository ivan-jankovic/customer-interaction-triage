// Migrations round trip on a fresh database: latest → down to none → latest again.
// Each run creates its own throwaway database, so the development database is never touched.

import { sql, type Kysely } from "kysely";
import { NO_MIGRATIONS } from "kysely/migration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import { createMigrator } from "../../src/db/migrate.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const P06_TO_P09_TABLES = [
  "crm_customers",
  "crm_services",
  "crm_tickets",
  "outages",
  "enrichments",
  "cases",
  "decision_log",
  "reviews",
  "unmask_log",
];

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
      ["0002_classifications", "Success"],
      ["0003_masking", "Success"],
      ["0004_crm", "Success"],
      ["0005_enrichments", "Success"],
      ["0006_cases", "Success"],
      ["0007_processing", "Success"],
      ["0008_reviews", "Success"],
    ]);
    expect(await appliedMigrations()).toEqual([
      "0000_baseline",
      "0001_interactions",
      "0002_classifications",
      "0003_masking",
      "0004_crm",
      "0005_enrichments",
      "0006_cases",
      "0007_processing",
      "0008_reviews",
    ]);
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

  describe("classifications constraints", () => {
    let interactionId: string;
    const insert = (columns: string, values: string) =>
      sql
        .raw(
          `insert into classifications (interaction_id, prompt_version, requested_model, served_model, effort,
             input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, latency_ms, ${columns})
           values ('${interactionId}', 'classify.v1', 'm', 'm', 'low', 0, 0, 0, 0, 0, ${values})`,
        )
        .execute(db);
    const validColumns = "outcome, intent, urgency, language, fields, summary, confidence";
    const valid = (confidence = "0.5") =>
      `'valid', 'other', 'low', 'cs', '{"identifiers": [], "service_type": "unknown", "area": null}', 's', ${confidence}`;

    beforeAll(async () => {
      const row = await db
        .insertInto("interactions")
        .values({ channel: "chat", raw_text: "for classifications" })
        .returning("id")
        .executeTakeFirstOrThrow();
      interactionId = row.id;
    });

    it("accepts a complete valid row and an invalid row without results", async () => {
      await insert(validColumns, valid());
      await insert("outcome, raw_output, errors", `'invalid', 'x', '["bad"]'`);
    });

    it.each([
      [
        "a valid row without an intent",
        "outcome, urgency, language, fields, summary, confidence",
        `'valid', 'low', 'cs', '{}', 's', 0.5`,
        "classifications_result_check",
      ],
      ["an invalid row with an intent", "outcome, intent", `'invalid', 'other'`, "classifications_result_check"],
      ["a confidence above 1", validColumns, valid("1.5"), "classifications_confidence_check"],
      ["an unknown outcome", "outcome", `'maybe'`, "classifications_outcome_check"],
      ["errors that are not a list", "outcome, errors", `'error', '{"a": 1}'`, "classifications_errors_check"],
    ])("rejects %s", async (_case, columns, values, constraint) => {
      await expect(insert(columns, values)).rejects.toThrow(constraint);
    });

    it("rejects a classification for an unknown interaction", async () => {
      await expect(
        sql`insert into classifications (interaction_id, outcome, prompt_version, requested_model, served_model, effort,
              input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, latency_ms)
            values (uuidv7(), 'error', 'v', 'm', 'm', 'low', 0, 0, 0, 0, 0)`.execute(db),
      ).rejects.toThrow(/foreign key/);
    });
  });

  describe("0007_processing", () => {
    it("allows the status processed and nothing else new", async () => {
      const { id } = await db
        .insertInto("interactions")
        .values({ channel: "chat", language: null, raw_text: "x" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db.updateTable("interactions").set({ status: "processed" }).where("id", "=", id).execute();
      await expect(sql`update interactions set status = 'queued' where id = ${id}`.execute(db)).rejects.toThrow(
        /interactions_status_check/,
      );
    });

    it("marks interactions that already have a case processed, and rolls back cleanly", async () => {
      await createMigrator(db).migrateTo("0006_cases");
      const ids: string[] = [];
      for (const text of ["with case", "without case"]) {
        const r = await sql<{ id: string }>`insert into interactions (channel, raw_text) values ('chat', ${text})
                                             returning id`.execute(db);
        ids.push(r.rows[0]!.id);
      }
      const cl = await sql<{ id: string }>`
        insert into classifications (interaction_id, outcome, prompt_version, requested_model, served_model, effort,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, latency_ms)
        values (${ids[0]}, 'error', 'v', 'm', 'm', 'low', 0, 0, 0, 0, 0) returning id`.execute(db);
      await sql`insert into cases (interaction_id, classification_id, target_team, needs_review, reason_codes, router_version)
                values (${ids[0]}, ${cl.rows[0]!.id}, 'general', true, '["classification_error"]', 'route.v1')`.execute(
        db,
      );

      expect((await createMigrator(db).migrateToLatest()).error).toBeUndefined();
      const statuses = await sql<{ raw_text: string; status: string }>`
        select raw_text, status from interactions where id in (${ids[0]}, ${ids[1]}) order by raw_text`.execute(db);
      expect(statuses.rows).toEqual([
        { raw_text: "with case", status: "processed" },
        { raw_text: "without case", status: "received" },
      ]);
    });

    it("allows a null classification_id only on a processing_failed case", async () => {
      const insertCase = async (codes: string) => {
        const r = await sql<{ id: string }>`insert into interactions (channel, raw_text) values ('chat', 'x')
                                             returning id`.execute(db);
        return sql`insert into cases (interaction_id, classification_id, target_team, needs_review, reason_codes, router_version)
                   values (${r.rows[0]!.id}, null, 'general', true, ${codes}::jsonb, 'route.v2')`.execute(db);
      };
      await expect(insertCase('["processing_failed"]')).resolves.toBeDefined();
      await expect(insertCase('["classification_error"]')).rejects.toThrow(/cases_classification_id_check/);
    });

    it("refuses to roll back while a failure case without a classification exists", async () => {
      const result = await createMigrator(db).migrateTo("0006_cases");
      expect(result.error).toBeDefined();
      await sql`delete from cases where classification_id is null`.execute(db);
      expect((await createMigrator(db).migrateTo("0006_cases")).error).toBeUndefined();
      expect((await createMigrator(db).migrateToLatest()).error).toBeUndefined();
    });
  });

  it("rolls back to no migrations and drops the table", async () => {
    const result = await createMigrator(db).migrateTo(NO_MIGRATIONS);
    expect(result.error).toBeUndefined();
    expect(result.results?.every((r) => r.status === "Success" && r.direction === "Down")).toBe(true);
    expect(await appliedMigrations()).toEqual([]);
    expect(await tableExists("interactions")).toBe(false);
    expect(await tableExists("classifications")).toBe(false);
    expect(await tableExists("masked_identifiers")).toBe(false);
    for (const table of P06_TO_P09_TABLES) expect(await tableExists(table), table).toBe(false);
  });

  it("migrates to latest again", async () => {
    const result = await createMigrator(db).migrateToLatest();
    expect(result.error).toBeUndefined();
    expect(result.results?.every((r) => r.status === "Success")).toBe(true);
    expect(await tableExists("interactions")).toBe(true);
    expect(await tableExists("classifications")).toBe(true);
    expect(await tableExists("masked_identifiers")).toBe(true);
    for (const table of P06_TO_P09_TABLES) expect(await tableExists(table), table).toBe(true);
  });
});
