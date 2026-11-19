// The enrichments table (P06 requirements.md, "Migration 0005"): one row per enrichment
// attempt, never updated; the current enrichment is the latest row. Value lists are written
// out on purpose: a migration is frozen in time.

import { sql, type Kysely } from "kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("enrichments")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("interaction_id", "uuid", (col) => col.notNull().references("interactions.id").onDelete("restrict"))
    .addColumn("classification_id", "uuid", (col) => col.references("classifications.id").onDelete("restrict"))
    .addColumn("enricher_version", "text", (col) => col.notNull())
    .addColumn("outcome", "text", (col) => col.notNull())
    // Restrict: reseeding the mock CRM must not silently orphan recorded enrichments.
    .addColumn("customer_id", "uuid", (col) => col.references("crm_customers.id").onDelete("restrict"))
    .addColumn("candidates", "jsonb", (col) => col.notNull())
    .addColumn("unmatched_placeholders", "jsonb", (col) => col.notNull())
    .addColumn("area", "text")
    .addColumn("area_source", "text")
    .addColumn("outage_ids", "jsonb", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "enrichments_outcome_check",
      sql`outcome in ('found', 'not_found', 'ambiguous', 'no_identifiers')`,
    )
    .addCheckConstraint("enrichments_customer_check", sql`(outcome = 'found') = (customer_id is not null)`)
    .addCheckConstraint("enrichments_area_source_check", sql`area_source in ('message', 'customer')`)
    .addCheckConstraint("enrichments_area_check", sql`(area is null) = (area_source is null)`)
    .addCheckConstraint(
      "enrichments_json_check",
      sql`jsonb_typeof(candidates) = 'array' and jsonb_typeof(unmatched_placeholders) = 'array'
        and jsonb_typeof(outage_ids) = 'array'`,
    )
    .execute();

  await db.schema
    .createIndex("enrichments_interaction_idx")
    .on("enrichments")
    .columns(["interaction_id", "id"])
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("enrichments").execute();
}
