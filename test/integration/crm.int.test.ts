// The mock CRM in PostgreSQL (P06): seeding, and lookups that agree with the in-memory CRM
// on the whole seed and on every dataset message's designed enrichment.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { runCrmSeed } from "../../src/cli/crm-seed.js";
import { countCrm, KyselyCrm, seedCrm } from "../../src/db/crm.js";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { enrich, lookupKey, type CrmServiceType } from "../../src/pipeline/enrich.js";
import { mask } from "../../src/pipeline/mask.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const seed = readCrmSeed();
let testDb: TestDatabase;
let crm: KyselyCrm;
const memory = memoryCrm(seed);

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  crm = new KyselyCrm(testDb.db);
});

afterAll(async () => {
  await testDb?.drop();
});

describe("crm:seed", () => {
  it("loads the seed's counts and prints them", async () => {
    const lines: string[] = [];
    expect(await runCrmSeed([], { db: testDb.db, out: (l) => lines.push(l) })).toBe(0);
    expect(await countCrm(testDb.db)).toEqual({
      customers: seed.customers.length,
      services: seed.services.length,
      tickets: seed.tickets.length,
      outages: seed.outages.length,
    });
    expect(lines.join("\n")).toContain(`${seed.customers.length} customers`);
  });

  it("leaves the same rows when run twice", async () => {
    const snapshot = async () => ({
      customers: await testDb.db.selectFrom("crm_customers").selectAll().orderBy("id").execute(),
      services: await testDb.db.selectFrom("crm_services").selectAll().orderBy("id").execute(),
      tickets: await testDb.db.selectFrom("crm_tickets").selectAll().orderBy("id").execute(),
      outages: await testDb.db.selectFrom("outages").selectAll().orderBy("id").execute(),
    });
    const before = await snapshot();
    await seedCrm(testDb.db, seed);
    expect(await snapshot()).toEqual(before);
  });

  it("stores the phone's national part and the area key for lookups", async () => {
    const mobile = await testDb.db
      .selectFrom("crm_services")
      .select(["phone", "phone_key"])
      .where("phone", "is not", null)
      .executeTakeFirstOrThrow();
    expect(mobile.phone_key).toBe(mobile.phone!.slice(-9));
    const outage = await testDb.db
      .selectFrom("outages")
      .select(["area", "area_key"])
      .where("area", "=", "Žilina")
      .executeTakeFirst();
    expect(outage?.area_key).toBe("zilina");
  });
});

describe("KyselyCrm agrees with the in-memory CRM", () => {
  it("for every key in the seed", async () => {
    const keys = [
      ...seed.customers.map((c) => ["customer_number", c.customer_number] as const),
      ...seed.customers.filter((c) => c.email).map((c) => ["email", c.email!] as const),
      ...seed.services.map((s) => ["contract_number", s.contract_number] as const),
      ...seed.services.filter((s) => s.phone).map((s) => ["phone", s.phone!] as const),
      ["customer_number", "MR00000000"] as const,
      ["phone", "+420000000000"] as const,
    ];
    for (const [type, value] of keys) {
      const key = lookupKey(type, value);
      expect((await crm.customersByKey(type, key)).sort(), `${type} ${value}`).toEqual(
        (await memory.customersByKey(type, key)).sort(),
      );
    }
  });

  it("for every customer's services", async () => {
    for (const c of seed.customers) {
      const order = (xs: { serviceType: string; area: string; status: string }[]) =>
        xs.map((x) => `${x.serviceType}|${x.area}|${x.status}`).sort();
      expect(order(await crm.servicesOfCustomer(c.id))).toEqual(order(await memory.servicesOfCustomer(c.id)));
    }
  });

  it("for outages in every outage's area, at every message's time, for every service type", async () => {
    const areas = [...new Set(seed.outages.map((o) => o.area)), "zilina", "Brno"];
    const types: (CrmServiceType | null)[] = ["internet", "mobile", "tv", null];
    const times = seed.messages.map((m) => new Date(m.received_at));
    for (const area of areas) {
      for (const type of types) {
        for (const at of times) {
          expect((await crm.outagesAt(area, type, at)).sort()).toEqual((await memory.outagesAt(area, type, at)).sort());
        }
      }
    }
  });

  it("for every dataset message's designed enrichment", async () => {
    const dataset = readJsonl<DatasetRecord>(PATHS.dataset);
    for (const r of dataset) {
      const m = seed.messages.find((x) => x.message_id === r.id)!;
      const labels = r.final ?? r.chosen;
      const result = await enrich(
        {
          identifiers: mask(r.text).identifiers,
          area: labels.fields.area,
          serviceType: labels.fields.service_type,
          receivedAt: new Date(m.received_at),
        },
        crm,
      );
      expect(
        {
          outcome: result.outcome,
          customer_id: result.customerId,
          area: result.area,
          area_source: result.areaSource,
          outage_ids: result.outageIds,
        },
        r.id,
      ).toEqual(m.expected);
    }
  });
});
