// The mock CRM and outage list (P06 requirements.md, "Data"). Schema only: the rows come from
// eval/data/crm/seed.json through `npm run crm:seed`. Value lists are written out on purpose:
// a migration is frozen in time.

import { sql, type Kysely } from "kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("crm_customers")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("customer_number", "text", (col) => col.notNull().unique())
    .addColumn("email", "text")
    .addColumn("segment", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .addCheckConstraint("crm_customers_segment_check", sql`segment in ('residential', 'business')`)
    // Stored in the form lookups compare by (src/pipeline/enrich.ts, lookupKey).
    .addCheckConstraint("crm_customers_number_check", sql`customer_number = upper(customer_number)`)
    .addCheckConstraint("crm_customers_email_check", sql`email = lower(email)`)
    .execute();
  // Not unique: a shared family address is one way for a lookup to be ambiguous.
  await db.schema.createIndex("crm_customers_email_idx").on("crm_customers").column("email").execute();

  await db.schema
    .createTable("crm_services")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("customer_id", "uuid", (col) => col.notNull().references("crm_customers.id").onDelete("cascade"))
    .addColumn("service_type", "text", (col) => col.notNull())
    .addColumn("tariff", "text", (col) => col.notNull())
    .addColumn("contract_number", "text", (col) => col.notNull().unique())
    .addColumn("phone", "text")
    // The phone's last 9 digits: the national number, which is what lookups compare.
    .addColumn("phone_key", "text", (col) =>
      col.generatedAlwaysAs(sql`right(regexp_replace(phone, '[^0-9]', '', 'g'), 9)`).stored(),
    )
    .addColumn("area", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("started_at", "timestamptz", (col) => col.notNull())
    .addCheckConstraint("crm_services_type_check", sql`service_type in ('internet', 'mobile', 'tv')`)
    .addCheckConstraint("crm_services_status_check", sql`status in ('active', 'terminated')`)
    .addCheckConstraint("crm_services_contract_check", sql`contract_number = upper(contract_number)`)
    .addCheckConstraint("crm_services_phone_check", sql`phone is null or phone ~ '^\\+42[01][0-9]{9}$'`)
    .execute();
  await db.schema.createIndex("crm_services_customer_idx").on("crm_services").column("customer_id").execute();
  await db.schema.createIndex("crm_services_phone_key_idx").on("crm_services").column("phone_key").execute();

  await db.schema
    .createTable("crm_tickets")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("customer_id", "uuid", (col) => col.notNull().references("crm_customers.id").onDelete("cascade"))
    .addColumn("service_id", "uuid", (col) => col.references("crm_services.id").onDelete("cascade"))
    .addColumn("category", "text", (col) => col.notNull())
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("opened_at", "timestamptz", (col) => col.notNull())
    .addColumn("closed_at", "timestamptz")
    .addCheckConstraint(
      "crm_tickets_category_check",
      sql`category in ('billing_question', 'technical_fault', 'tariff_change', 'cancellation', 'complaint', 'other')`,
    )
    .addCheckConstraint("crm_tickets_closed_check", sql`closed_at is null or closed_at >= opened_at`)
    .execute();
  await db.schema.createIndex("crm_tickets_customer_idx").on("crm_tickets").column("customer_id").execute();

  await db.schema
    .createTable("outages")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("area", "text", (col) => col.notNull())
    // The area without case and diacritics (normalizeArea in src/pipeline/enrich.ts), written by
    // the seed loader. PostgreSQL's unaccent() is an extension and not immutable, so it can't
    // back a generated column; computing the key in one place in code keeps both CRMs equal.
    .addColumn("area_key", "text", (col) => col.notNull())
    .addColumn("service_type", "text", (col) => col.notNull())
    .addColumn("description", "text", (col) => col.notNull())
    .addColumn("started_at", "timestamptz", (col) => col.notNull())
    .addColumn("resolved_at", "timestamptz")
    .addCheckConstraint("outages_type_check", sql`service_type in ('internet', 'mobile', 'tv')`)
    .addCheckConstraint("outages_window_check", sql`resolved_at is null or resolved_at > started_at`)
    .execute();
  await db.schema.createIndex("outages_area_key_idx").on("outages").column("area_key").execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's documented migration signature
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("outages").execute();
  await db.schema.dropTable("crm_tickets").execute();
  await db.schema.dropTable("crm_services").execute();
  await db.schema.dropTable("crm_customers").execute();
}
