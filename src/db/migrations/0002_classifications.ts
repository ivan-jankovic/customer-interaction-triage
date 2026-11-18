// The classifications table (P03 requirements.md, "Table classifications"): one row per
// understanding attempt, valid or not; rows are never updated. Value lists are written out
// here on purpose: a migration is frozen in time and must not change when src/taxonomy.ts does.

import { sql, type Kysely } from "kysely";

const RESULT_COLUMNS = ["intent", "urgency", "language", "fields", "summary", "confidence"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("classifications")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("interaction_id", "uuid", (col) => col.notNull().references("interactions.id").onDelete("restrict"))
    .addColumn("outcome", "text", (col) => col.notNull())
    .addColumn("intent", "text")
    .addColumn("urgency", "text")
    .addColumn("language", "text")
    .addColumn("fields", "jsonb")
    .addColumn("summary", "text")
    .addColumn("confidence", "real")
    .addColumn("raw_output", "text")
    .addColumn("errors", "jsonb", (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("prompt_version", "text", (col) => col.notNull())
    .addColumn("requested_model", "text", (col) => col.notNull())
    .addColumn("served_model", "text", (col) => col.notNull())
    .addColumn("fell_back", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("effort", "text", (col) => col.notNull())
    .addColumn("input_tokens", "integer", (col) => col.notNull())
    .addColumn("output_tokens", "integer", (col) => col.notNull())
    .addColumn("cache_creation_input_tokens", "integer", (col) => col.notNull())
    .addColumn("cache_read_input_tokens", "integer", (col) => col.notNull())
    .addColumn("cost_usd", "numeric(12, 6)")
    .addColumn("latency_ms", "integer", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("classifications_outcome_check", sql`outcome in ('valid', 'invalid', 'error')`)
    // The result columns are filled exactly when the outcome is valid.
    .addCheckConstraint(
      "classifications_result_check",
      sql`(outcome = 'valid' and ${sql.join(
        RESULT_COLUMNS.map((c) => sql`${sql.ref(c)} is not null`),
        sql` and `,
      )}) or (outcome <> 'valid' and ${sql.join(
        RESULT_COLUMNS.map((c) => sql`${sql.ref(c)} is null`),
        sql` and `,
      )})`,
    )
    .addCheckConstraint(
      "classifications_intent_check",
      sql`intent in ('billing_question', 'technical_fault', 'tariff_change', 'cancellation', 'complaint', 'other')`,
    )
    .addCheckConstraint("classifications_urgency_check", sql`urgency in ('low', 'normal', 'high')`)
    .addCheckConstraint("classifications_language_check", sql`language in ('cs', 'sk', 'en')`)
    .addCheckConstraint("classifications_confidence_check", sql`confidence between 0 and 1`)
    .addCheckConstraint("classifications_errors_check", sql`jsonb_typeof(errors) = 'array'`)
    .execute();

  await db.schema
    .createIndex("classifications_interaction_idx")
    .on("classifications")
    .columns(["interaction_id", "created_at"])
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("classifications").execute();
}
