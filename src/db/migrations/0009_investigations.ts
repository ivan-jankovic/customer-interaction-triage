// The investigating agent (P10 requirements.md, "Migration 0009"):
// - crm_line_status: mock line state per service, loaded from the seed by `npm run crm:seed`;
// - investigations: one row per agent attempt, never updated;
// - decision_log: the step list gains `investigate` and seq goes up to 5 (mask, classify,
//   enrich, investigate, route). Cases written before keep their four entries.
// Value lists are written out on purpose: a migration is frozen in time.

import { sql, type Kysely } from "kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("crm_line_status")
    .addColumn("service_id", "uuid", (col) => col.primaryKey().references("crm_services.id").onDelete("cascade"))
    .addColumn("state", "text", (col) => col.notNull())
    .addColumn("state_since", "timestamptz", (col) => col.notNull())
    .addColumn("diagnostic", "text", (col) => col.notNull())
    .addCheckConstraint("crm_line_status_state_check", sql`state in ('up', 'degraded', 'down')`)
    .execute();

  await db.schema
    .createTable("investigations")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("interaction_id", "uuid", (col) => col.notNull().references("interactions.id").onDelete("restrict"))
    .addColumn("classification_id", "uuid", (col) =>
      col.notNull().references("classifications.id").onDelete("restrict"),
    )
    .addColumn("enrichment_id", "uuid", (col) => col.notNull().references("enrichments.id").onDelete("restrict"))
    .addColumn("investigator_version", "text", (col) => col.notNull())
    .addColumn("prompt_version", "text", (col) => col.notNull())
    .addColumn("outcome", "text", (col) => col.notNull())
    .addColumn("likely_cause", "text")
    .addColumn("confidence", "numeric")
    .addColumn("summary", "text")
    .addColumn("evidence", "jsonb", (col) => col.notNull())
    .addColumn("steps", "integer", (col) => col.notNull())
    .addColumn("tool_calls", "jsonb", (col) => col.notNull())
    .addColumn("raw_output", "text")
    .addColumn("errors", "jsonb", (col) => col.notNull())
    .addColumn("requested_model", "text", (col) => col.notNull())
    .addColumn("served_model", "text", (col) => col.notNull())
    .addColumn("effort", "text", (col) => col.notNull())
    .addColumn("input_tokens", "integer", (col) => col.notNull())
    .addColumn("output_tokens", "integer", (col) => col.notNull())
    .addColumn("cache_creation_input_tokens", "integer", (col) => col.notNull())
    .addColumn("cache_read_input_tokens", "integer", (col) => col.notNull())
    .addColumn("cost_usd", "numeric")
    .addColumn("latency_ms", "integer", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("investigations_outcome_check", sql`outcome in ('valid', 'step_limit', 'invalid', 'error')`)
    .addCheckConstraint(
      "investigations_cause_check",
      sql`likely_cause is null or likely_cause in ('area_outage', 'line_fault', 'customer_equipment', 'service_inactive', 'inconclusive')`,
    )
    .addCheckConstraint(
      "investigations_valid_check",
      sql`(outcome = 'valid') = (likely_cause is not null and confidence is not null and summary is not null)`,
    )
    .addCheckConstraint(
      "investigations_unset_check",
      sql`outcome = 'valid' or (likely_cause is null and confidence is null and summary is null)`,
    )
    .addCheckConstraint(
      "investigations_confidence_check",
      sql`confidence is null or (confidence >= 0 and confidence <= 1)`,
    )
    .addCheckConstraint("investigations_steps_check", sql`steps between 1 and 6`)
    .addCheckConstraint("investigations_evidence_check", sql`jsonb_typeof(evidence) = 'array'`)
    .addCheckConstraint("investigations_tool_calls_check", sql`jsonb_typeof(tool_calls) = 'array'`)
    .execute();
  await db.schema
    .createIndex("investigations_interaction_idx")
    .on("investigations")
    .columns(["interaction_id", "id"])
    .execute();
  await db.schema
    .createIndex("investigations_enrichment_idx")
    .on("investigations")
    .columns(["enrichment_id", "id"])
    .execute();

  await db.schema.alterTable("decision_log").dropConstraint("decision_log_step_check").execute();
  await db.schema.alterTable("decision_log").dropConstraint("decision_log_seq_check").execute();
  await db.schema
    .alterTable("decision_log")
    .addCheckConstraint("decision_log_step_check", sql`step in ('mask', 'classify', 'enrich', 'investigate', 'route')`)
    .execute();
  await db.schema
    .alterTable("decision_log")
    .addCheckConstraint("decision_log_seq_check", sql`seq between 1 and 5`)
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  // Fails while a decision-log entry for `investigate` (or a fifth entry) exists, which is
  // expected: such a case can't be represented in the 0008 schema.
  await db.schema.alterTable("decision_log").dropConstraint("decision_log_step_check").execute();
  await db.schema.alterTable("decision_log").dropConstraint("decision_log_seq_check").execute();
  await db.schema
    .alterTable("decision_log")
    .addCheckConstraint("decision_log_step_check", sql`step in ('mask', 'classify', 'enrich', 'route')`)
    .execute();
  await db.schema
    .alterTable("decision_log")
    .addCheckConstraint("decision_log_seq_check", sql`seq between 1 and 4`)
    .execute();

  await db.schema.dropTable("investigations").execute();
  await db.schema.dropTable("crm_line_status").execute();
}
