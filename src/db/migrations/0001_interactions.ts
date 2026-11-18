// The interactions table (P02 requirements.md, "Data"). Columns for later steps
// (masked_text in P05, more statuses in P08) are added by the phases that use them.

import { sql, type Kysely } from "kysely";

// Migrations are frozen in time, so they don't import the current types or value lists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("interactions")
    // uuidv7() is built into PostgreSQL 18: time-ordered ids, so the list can page by id.
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    // Unique allows any number of NULLs; ON CONFLICT (external_id) relies on this constraint.
    .addColumn("external_id", "text", (col) => col.unique())
    .addColumn("channel", "text", (col) => col.notNull())
    .addColumn("language", "text")
    .addColumn("raw_text", "text", (col) => col.notNull())
    .addColumn("received_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("received"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("interactions_channel_check", sql`channel in ('email', 'chat', 'call')`)
    .addCheckConstraint("interactions_language_check", sql`language in ('cs', 'sk', 'en')`)
    .addCheckConstraint("interactions_status_check", sql`status in ('received')`)
    .addCheckConstraint("interactions_raw_text_check", sql`raw_text ~ '\\S'`)
    .execute();

  await db.schema.createIndex("interactions_received_at_idx").on("interactions").column("received_at").execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("interactions").execute();
}
