// The review queue's tables (P09 requirements.md, "Migration 0008"):
// - reviews: at most one per case (unique case_id), written once. A correction stores both final
//   values (intent and team), so the effective decision is read from one row.
// - unmask_log: one row each time a reviewer views a message's raw text; append-only.
// Value lists and the handle pattern are written out on purpose: a migration is frozen in time.

import { sql, type Kysely } from "kysely";

const HANDLE = sql`'^[a-z0-9][a-z0-9._-]{1,31}$'`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("reviews")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("case_id", "uuid", (col) => col.notNull().unique().references("cases.id").onDelete("restrict"))
    .addColumn("reviewer", "text", (col) => col.notNull())
    .addColumn("decision", "text", (col) => col.notNull())
    .addColumn("corrected_intent", "text")
    .addColumn("corrected_team", "text")
    .addColumn("note", "text")
    .addColumn("spot_check", "boolean", (col) => col.notNull())
    .addColumn("reviewed_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("reviews_reviewer_check", sql`reviewer ~ ${HANDLE}`)
    .addCheckConstraint("reviews_decision_check", sql`decision in ('confirmed', 'corrected')`)
    .addCheckConstraint(
      "reviews_corrected_intent_check",
      sql`corrected_intent in ('billing_question', 'technical_fault', 'tariff_change', 'cancellation', 'complaint', 'other')`,
    )
    .addCheckConstraint(
      "reviews_corrected_team_check",
      sql`corrected_team in ('billing', 'technical_support', 'sales', 'retention', 'complaints', 'general')`,
    )
    .addCheckConstraint("reviews_note_check", sql`note is null or char_length(note) between 1 and 1000`)
    // Corrected values are set exactly when the decision is `corrected`, and a correction has a note.
    .addCheckConstraint(
      "reviews_correction_check",
      sql`(decision = 'confirmed' and corrected_intent is null and corrected_team is null)
          or (decision = 'corrected' and corrected_intent is not null and corrected_team is not null and note is not null)`,
    )
    .execute();
  await db.schema.createIndex("reviews_reviewer_idx").on("reviews").column("reviewer").execute();

  await db.schema
    .createTable("unmask_log")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("case_id", "uuid", (col) => col.notNull().references("cases.id").onDelete("restrict"))
    .addColumn("reviewer", "text", (col) => col.notNull())
    .addColumn("reason", "text", (col) => col.notNull())
    .addColumn("unmasked_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("unmask_log_reviewer_check", sql`reviewer ~ ${HANDLE}`)
    .addCheckConstraint("unmask_log_reason_check", sql`char_length(reason) between 3 and 500`)
    .execute();
  await db.schema.createIndex("unmask_log_case_id_idx").on("unmask_log").column("case_id").execute();
  await db.schema.createIndex("unmask_log_reviewer_idx").on("unmask_log").column("reviewer").execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("unmask_log").execute();
  await db.schema.dropTable("reviews").execute();
}
