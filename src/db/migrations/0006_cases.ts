// The cases and decision_log tables (P07 requirements.md, "Migration 0006"). One case per
// interaction, written once together with one decision-log entry per pipeline step. Value
// lists are written out on purpose: a migration is frozen in time.

import { sql, type Kysely } from "kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("cases")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    // Unique: exactly one case per interaction, so a second routing (or a second P08 job) can't add one.
    .addColumn("interaction_id", "uuid", (col) =>
      col.notNull().unique().references("interactions.id").onDelete("restrict"),
    )
    .addColumn("classification_id", "uuid", (col) =>
      col.notNull().references("classifications.id").onDelete("restrict"),
    )
    .addColumn("enrichment_id", "uuid", (col) => col.references("enrichments.id").onDelete("restrict"))
    .addColumn("customer_id", "uuid", (col) => col.references("crm_customers.id").onDelete("restrict"))
    .addColumn("target_team", "text", (col) => col.notNull())
    .addColumn("needs_review", "boolean", (col) => col.notNull())
    .addColumn("reason_codes", "jsonb", (col) => col.notNull())
    .addColumn("router_version", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "cases_target_team_check",
      sql`target_team in ('billing', 'technical_support', 'sales', 'retention', 'complaints', 'general')`,
    )
    .addCheckConstraint("cases_reason_codes_check", sql`jsonb_typeof(reason_codes) = 'array'`)
    .addCheckConstraint("cases_needs_review_check", sql`needs_review = (jsonb_array_length(reason_codes) > 0)`)
    .execute();

  await db.schema.createIndex("cases_needs_review_idx").on("cases").columns(["needs_review", "id"]).execute();

  await db.schema
    .createTable("decision_log")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("case_id", "uuid", (col) => col.notNull().references("cases.id").onDelete("restrict"))
    .addColumn("seq", "integer", (col) => col.notNull())
    .addColumn("step", "text", (col) => col.notNull())
    .addColumn("input_summary", "jsonb", (col) => col.notNull())
    .addColumn("output", "jsonb", (col) => col.notNull())
    .addColumn("rule_applied", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("decision_log_step_check", sql`step in ('mask', 'classify', 'enrich', 'route')`)
    .addCheckConstraint("decision_log_seq_check", sql`seq between 1 and 4`)
    .addUniqueConstraint("decision_log_case_step_unique", ["case_id", "step"])
    .addUniqueConstraint("decision_log_case_seq_unique", ["case_id", "seq"])
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("decision_log").execute();
  await db.schema.dropTable("cases").execute();
}
