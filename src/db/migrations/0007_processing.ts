// Asynchronous processing (P08 requirements.md, "Migration 0007"):
// - interactions.status gains `processed`, set in the same transaction as the case; interactions
//   that already have a case (routed from the P07 CLI) are marked processed here.
// - cases.classification_id becomes nullable, for failure cases only: a job that fails before or
//   during classification still ends as exactly one case, with reason code processing_failed.
// Value lists are written out on purpose: a migration is frozen in time.

import { sql, type Kysely } from "kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("interactions").dropConstraint("interactions_status_check").execute();
  await db.schema
    .alterTable("interactions")
    .addCheckConstraint("interactions_status_check", sql`status in ('received', 'processed')`)
    .execute();
  await sql`update interactions set status = 'processed'
            where exists (select 1 from cases where cases.interaction_id = interactions.id)`.execute(db);

  await db.schema
    .alterTable("cases")
    .alterColumn("classification_id", (col) => col.dropNotNull())
    .execute();
  await db.schema
    .alterTable("cases")
    .addCheckConstraint(
      "cases_classification_id_check",
      sql`classification_id is not null or reason_codes ? 'processing_failed'`,
    )
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  // Fails while a failure case without a classification exists, which is expected: such a case
  // can't be represented in the 0006 schema.
  await db.schema.alterTable("cases").dropConstraint("cases_classification_id_check").execute();
  await db.schema
    .alterTable("cases")
    .alterColumn("classification_id", (col) => col.setNotNull())
    .execute();

  await db.schema.alterTable("interactions").dropConstraint("interactions_status_check").execute();
  await sql`update interactions set status = 'received'`.execute(db);
  await db.schema
    .alterTable("interactions")
    .addCheckConstraint("interactions_status_check", sql`status in ('received')`)
    .execute();
}
