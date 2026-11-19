// Masking storage (P05 requirements.md, "Data"): the masked text on interactions, and one
// row per placeholder in masked_identifiers (the mapping P06's CRM lookup uses). Value lists
// are written out: a migration is frozen in time.

import { sql, type Kysely } from "kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("interactions")
    .addColumn("masked_text", "text")
    .addColumn("masker_version", "text")
    .addColumn("masked_at", "timestamptz")
    .execute();
  // Masking is set once, completely, or not at all.
  await db.schema
    .alterTable("interactions")
    .addCheckConstraint(
      "interactions_masking_check",
      sql`(masked_text is null and masker_version is null and masked_at is null)
        or (masked_text is not null and masker_version is not null and masked_at is not null)`,
    )
    .execute();

  await db.schema
    .createTable("masked_identifiers")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("interaction_id", "uuid", (col) => col.notNull().references("interactions.id").onDelete("restrict"))
    .addColumn("placeholder", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("normalized_value", "text", (col) => col.notNull())
    .addColumn("start_offset", "integer", (col) => col.notNull())
    .addColumn("end_offset", "integer", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("masked_identifiers_placeholder_unique", ["interaction_id", "placeholder"])
    .addCheckConstraint(
      "masked_identifiers_type_check",
      sql`type in ('customer_number', 'contract_number', 'phone', 'email', 'birth_number', 'bank_account', 'iban')`,
    )
    .addCheckConstraint("masked_identifiers_offsets_check", sql`start_offset >= 0 and end_offset > start_offset`)
    .execute();

  await db.schema
    .createIndex("masked_identifiers_lookup_idx")
    .on("masked_identifiers")
    .columns(["type", "normalized_value"])
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("masked_identifiers").execute();
  await db.schema.alterTable("interactions").dropConstraint("interactions_masking_check").execute();
  await db.schema
    .alterTable("interactions")
    .dropColumn("masked_text")
    .dropColumn("masker_version")
    .dropColumn("masked_at")
    .execute();
}
