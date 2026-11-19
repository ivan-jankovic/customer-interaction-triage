// The mock CRM in PostgreSQL (P06): the CrmLookup the enrichment step uses, the seed loader
// behind `npm run crm:seed`, and the reads the enrich CLI prints. Keys are compared in the form
// lookupKey() gives, which is how the seed stores them (checked by migration 0004), so the
// PostgreSQL and in-memory lookups agree (an integration test checks this on the whole seed).

import { sql, type Kysely } from "kysely";
import {
  normalizeArea,
  type CrmLookup,
  type CrmServiceType,
  type LookupKeyType,
  type ServiceSummary,
} from "../pipeline/enrich.js";
import type { CrmSeed } from "./crm-seed.js";
import type { Database } from "./database.js";

export class KyselyCrm implements CrmLookup {
  constructor(private readonly db: Kysely<Database>) {}

  async customersByKey(type: LookupKeyType, key: string): Promise<string[]> {
    let rows: { id: string }[];
    switch (type) {
      case "customer_number":
        rows = await this.db.selectFrom("crm_customers").select("id").where("customer_number", "=", key).execute();
        break;
      case "email":
        rows = await this.db.selectFrom("crm_customers").select("id").where("email", "=", key).execute();
        break;
      case "contract_number":
        rows = await this.db
          .selectFrom("crm_services")
          .select("customer_id as id")
          .where("contract_number", "=", key)
          .execute();
        break;
      case "phone":
        rows = await this.db
          .selectFrom("crm_services")
          .select("customer_id as id")
          .where("phone_key", "=", key)
          .execute();
        break;
    }
    return [...new Set(rows.map((r) => r.id))];
  }

  async servicesOfCustomer(customerId: string): Promise<ServiceSummary[]> {
    const rows = await this.db
      .selectFrom("crm_services")
      .select(["service_type", "area", "status"])
      .where("customer_id", "=", customerId)
      .execute();
    return rows.map((r) => ({ serviceType: r.service_type, area: r.area, status: r.status }));
  }

  async outagesAt(area: string, serviceType: CrmServiceType | null, at: Date): Promise<string[]> {
    let query = this.db
      .selectFrom("outages")
      .select("id")
      .where("area_key", "=", normalizeArea(area))
      .where("started_at", "<=", at)
      .where((eb) => eb.or([eb("resolved_at", "is", null), eb("resolved_at", ">", at)]));
    if (serviceType) query = query.where("service_type", "=", serviceType);
    return (await query.execute()).map((r) => r.id);
  }
}

export interface SeedCounts {
  customers: number;
  services: number;
  tickets: number;
  outages: number;
}

/** Thrown when enrichments still point at the CRM rows a reseed would delete. */
export class CrmInUse extends Error {}

/**
 * Replaces the four mock tables' rows with the seed, in one transaction, so running it twice
 * leaves the same rows. Refuses when enrichments reference customers: those rows record what
 * the CRM said at the time, so reseeding needs a fresh database instead.
 */
export async function seedCrm(db: Kysely<Database>, seed: CrmSeed): Promise<SeedCounts> {
  return db.transaction().execute(async (trx) => {
    const used = await trx
      .selectFrom("enrichments")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("customer_id", "is not", null)
      .executeTakeFirstOrThrow();
    if (Number(used.n) > 0) {
      throw new CrmInUse(
        `${used.n} enrichments reference CRM customers, so the mock CRM can't be replaced. ` +
          "Reseed a fresh database (docker compose down -v, then db:migrate and crm:seed).",
      );
    }
    await trx.deleteFrom("crm_tickets").execute();
    await trx.deleteFrom("crm_services").execute();
    await trx.deleteFrom("crm_customers").execute();
    await trx.deleteFrom("outages").execute();

    // Inserted in chunks: one statement for 100+ rows stays well under PostgreSQL's parameter limit.
    const chunks = <T>(rows: readonly T[], size = 200): T[][] =>
      Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
    for (const rows of chunks(seed.customers)) await trx.insertInto("crm_customers").values(rows).execute();
    for (const rows of chunks(seed.services)) await trx.insertInto("crm_services").values(rows).execute();
    for (const rows of chunks(seed.tickets)) await trx.insertInto("crm_tickets").values(rows).execute();
    for (const rows of chunks(seed.outages)) {
      await trx
        .insertInto("outages")
        .values(rows.map((o) => ({ ...o, area_key: normalizeArea(o.area) })))
        .execute();
    }
    return {
      customers: seed.customers.length,
      services: seed.services.length,
      tickets: seed.tickets.length,
      outages: seed.outages.length,
    };
  });
}

/** Row counts of the four mock tables. */
export async function countCrm(db: Kysely<Database>): Promise<SeedCounts> {
  const count = async (table: "crm_customers" | "crm_services" | "crm_tickets" | "outages") =>
    Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(db)).rows[0]!.n);
  return {
    customers: await count("crm_customers"),
    services: await count("crm_services"),
    tickets: await count("crm_tickets"),
    outages: await count("outages"),
  };
}

/** For printing: a customer with their services. */
export async function customerDetails(db: Kysely<Database>, customerId: string) {
  const customer = await db
    .selectFrom("crm_customers")
    .select(["id", "customer_number", "segment"])
    .where("id", "=", customerId)
    .executeTakeFirstOrThrow();
  const services = await db
    .selectFrom("crm_services")
    .select(["service_type", "tariff", "area", "status"])
    .where("customer_id", "=", customerId)
    .orderBy("started_at")
    .execute();
  return { ...customer, services };
}

export async function outagesByIds(db: Kysely<Database>, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db
    .selectFrom("outages")
    .select(["id", "area", "service_type", "description", "started_at", "resolved_at"])
    .where("id", "in", ids)
    .orderBy("started_at")
    .execute();
}
