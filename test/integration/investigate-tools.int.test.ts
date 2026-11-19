// The agent's tools on PostgreSQL (P10 validation.md, "Tools"): they read through a READ ONLY
// transaction, so a write in it fails, and they give the same results as over the in-memory seed.

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inReadOnlyTransaction, readOnlyCrm, seedCrm } from "../../src/db/crm.js";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { runTool } from "../../src/pipeline/investigate-tools.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const seed = readCrmSeed();
let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  await seedCrm(testDb.db, seed);
});

afterAll(async () => {
  await testDb?.drop();
});

describe("the tools' read-only access", () => {
  it("refuses a write inside the tools' transaction", async () => {
    await expect(
      inReadOnlyTransaction(testDb.db, (trx) =>
        sql`update crm_line_status set state = 'up'`.execute(trx).then(() => undefined),
      ),
    ).rejects.toThrow(/read-only transaction/);
    await expect(
      inReadOnlyTransaction(testDb.db, (trx) =>
        trx
          .deleteFrom("outages")
          .execute()
          .then(() => undefined),
      ),
    ).rejects.toThrow(/read-only transaction/);
    expect((await testDb.db.selectFrom("outages").select("id").execute()).length).toBe(seed.outages.length);
  });

  it("gives the same tool results as the in-memory CRM for every technical fault", async () => {
    const pg = readOnlyCrm(testDb.db);
    const memory = memoryCrm(seed);
    const faults = seed.messages.filter((m) => m.expected_cause !== null);
    for (const m of faults) {
      const customerIds = seed.customers.map((c) => c.id);
      const base = { receivedAt: new Date(m.received_at), customerIds };
      const calls: [string, unknown][] = [
        ...(m.expected.area ? ([["check_outages", { area: m.expected.area }]] as [string, unknown][]) : []),
        ...(m.expected.customer_id
          ? ([
              ["get_line_status", { customer_id: m.expected.customer_id }],
              ["get_recent_tickets", { customer_id: m.expected.customer_id }],
            ] as [string, unknown][])
          : []),
      ];
      for (const [tool, input] of calls) {
        const a = await runTool(tool, input, { ...base, crm: pg });
        const b = await runTool(tool, input, { ...base, crm: memory });
        expect(a, `${m.message_id} ${tool}`).toEqual(b);
        expect(a.isError).toBe(false);
      }
    }
  });
});
