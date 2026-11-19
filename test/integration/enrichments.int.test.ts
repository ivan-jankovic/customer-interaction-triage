// The enrichment step with storage, and the enrich CLI (P06), on dataset messages stored the way
// the pipeline stores them: interaction with the seed's received_at, masking, and a valid
// classification carrying the labelled area and service type (no model is called).

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { runCrmSeed } from "../../src/cli/crm-seed.js";
import { runEnrich } from "../../src/cli/enrich.js";
import { KyselyClassificationStore } from "../../src/db/classifications.js";
import { seedCrm } from "../../src/db/crm.js";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import { enrichInteraction, listEnrichments, NotReadyForEnrichment } from "../../src/db/enrichments.js";
import { maskInteraction } from "../../src/db/masking.js";
import { ENRICHER_VERSION } from "../../src/pipeline/enrich.js";
import { attempt, invalidAttempt, VALID_CLASSIFICATION } from "../support/attempts.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const seed = readCrmSeed();
const dataset = readJsonl<DatasetRecord>(PATHS.dataset);
let testDb: TestDatabase;

/** Stores a dataset message as intake would, optionally masked and classified with its labels. */
async function store(messageId: string, { mask = true, classify = true } = {}): Promise<string> {
  const r = dataset.find((x) => x.id === messageId)!;
  const m = seed.messages.find((x) => x.message_id === messageId)!;
  const { id } = await testDb.db
    .insertInto("interactions")
    .values({
      external_id: `${messageId}-${Math.random()}`,
      channel: r.channel,
      raw_text: r.text,
      received_at: m.received_at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (mask) await maskInteraction(testDb.db, id);
  if (classify) {
    const labels = r.final ?? r.chosen;
    await new KyselyClassificationStore(testDb.db).record(
      id,
      attempt({
        classification: {
          ...VALID_CLASSIFICATION,
          intent: labels.intent,
          fields: { identifiers: [], service_type: labels.fields.service_type, area: labels.fields.area },
        },
      }),
    );
  }
  return id;
}

const expected = (messageId: string) => seed.messages.find((m) => m.message_id === messageId)!.expected;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  await seedCrm(testDb.db, seed);
});

afterAll(async () => {
  await testDb?.drop();
});

describe("enrichInteraction", () => {
  it.each(["msg-011", "msg-097", "msg-022", "msg-007", "msg-055"])(
    "%s: stores the designed enrichment with its classification and version",
    async (messageId) => {
      const id = await store(messageId);
      const e = await enrichInteraction(testDb.db, id);
      const classification = await new KyselyClassificationStore(testDb.db).latestValid(id);
      expect({
        outcome: e.outcome,
        customer_id: e.customerId,
        area: e.area,
        area_source: e.areaSource,
        outage_ids: e.outageIds,
      }).toEqual(expected(messageId));
      expect(e).toMatchObject({
        interactionId: id,
        classificationId: classification!.id,
        enricherVersion: ENRICHER_VERSION,
      });
      expect(await listEnrichments(testDb.db, id)).toEqual([e]);
    },
  );

  it("records candidates and unmatched placeholders", async () => {
    const ambiguous = await enrichInteraction(testDb.db, await store("msg-014"));
    expect(ambiguous.candidates).toHaveLength(2);
    expect(ambiguous.candidates.flatMap((c) => c.placeholders).sort()).toEqual(["[CUSTOMER_NUMBER_1]", "[PHONE_1]"]);
    const unmatched = await enrichInteraction(testDb.db, await store("msg-055"));
    expect(unmatched.unmatchedPlaceholders).toEqual(["[PHONE_1]"]);
  });

  it("adds a new row on every call, newest first", async () => {
    const id = await store("msg-011");
    const first = await enrichInteraction(testDb.db, id);
    const second = await enrichInteraction(testDb.db, id);
    expect(second.id).not.toBe(first.id);
    expect((await listEnrichments(testDb.db, id)).map((e) => e.id)).toEqual([second.id, first.id]);
  });

  it("fails without a masking, or without a valid classification, and stores nothing", async () => {
    const unmasked = await store("msg-011", { mask: false, classify: false });
    await expect(enrichInteraction(testDb.db, unmasked)).rejects.toThrow(NotReadyForEnrichment);
    const unclassified = await store("msg-011", { classify: false });
    await new KyselyClassificationStore(testDb.db).record(unclassified, invalidAttempt());
    await expect(enrichInteraction(testDb.db, unclassified)).rejects.toThrow(/no valid classification/);
    expect(await listEnrichments(testDb.db, unmasked)).toEqual([]);
    expect(await listEnrichments(testDb.db, unclassified)).toEqual([]);
  });
});

describe("enrichments constraints", () => {
  const insert = async (values: Record<string, string | null>) => {
    const id = await store("msg-007", { mask: false, classify: false });
    const v = { outcome: "not_found", customer_id: null, area: null, area_source: null, ...values };
    return sql`insert into enrichments (interaction_id, enricher_version, outcome, customer_id, candidates,
                 unmatched_placeholders, area, area_source, outage_ids)
               values (${id}, 'enrich.v1', ${v.outcome}, ${v.customer_id}, '[]', '[]', ${v.area}, ${v.area_source}, '[]')`.execute(
      testDb.db,
    );
  };
  const customerId = seed.customers[0]!.id;

  it("accepts a consistent row", async () => {
    await expect(
      insert({ outcome: "found", customer_id: customerId, area: "Opava", area_source: "message" }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["customer_id without found", { outcome: "ambiguous", customer_id: customerId }, /enrichments_customer_check/],
    ["found without customer_id", { outcome: "found" }, /enrichments_customer_check/],
    ["an unknown outcome", { outcome: "maybe" }, /enrichments_outcome_check/],
    ["area_source without area", { area_source: "message" }, /enrichments_area_check/],
    ["an unknown area source", { area: "Opava", area_source: "guess" }, /enrichments_area_source_check/],
  ])("rejects %s", async (_name, values, error) => {
    await expect(insert(values)).rejects.toThrow(error);
  });
});

describe("crm:seed after enrichments", () => {
  it("refuses to replace the CRM while enrichments reference its customers", async () => {
    await enrichInteraction(testDb.db, await store("msg-011"));
    const errors: string[] = [];
    expect(await runCrmSeed([], { db: testDb.db, out: () => {}, err: (l) => errors.push(l) })).toBe(1);
    expect(errors.join("\n")).toMatch(/reference CRM customers/);
  });
});

describe("npm run enrich", () => {
  const run = async (ref: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runEnrich([ref], { db: testDb.db, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const externalId = async (id: string) =>
    (await testDb.db.selectFrom("interactions").select("external_id").where("id", "=", id).executeTakeFirstOrThrow())
      .external_id!;

  it("prints a found customer with services, the area and the matching outage, and no identifier values", async () => {
    const id = await store("msg-011");
    const { code, out } = await run(await externalId(id));
    expect(code).toBe(0);
    expect(out).toContain("Customer lookup: found");
    expect(out).toContain("matched by [CUSTOMER_NUMBER_1]");
    expect(out).toMatch(/\| mobile \| Merelo [^|]+ \| Opava \| active \|/);
    expect(out).toContain("Area: Opava (from the message)");
    expect(out).toMatch(/Outages:\n {2}- Opava, mobile, since 2026-11-06T/);
    const r = dataset.find((x) => x.id === "msg-011")!;
    for (const i of (r.final ?? r.chosen).fields.identifiers) expect(out).not.toContain(i.value);
  });

  it("prints the candidates of an ambiguous message", async () => {
    const { code, out } = await run(await store("msg-022"));
    expect(code).toBe(0);
    expect(out).toContain("Customer lookup: ambiguous");
    expect(out.match(/- customer [0-9a-f-]{36}, matched by \[EMAIL_1\]/g)).toHaveLength(2);
    expect(out).toContain("Area: none");
    expect(out).not.toContain("@example");
  });

  it("explains what is missing when the message isn't classified", async () => {
    const { code, err } = await run(await store("msg-011", { classify: false }));
    expect(code).toBe(1);
    expect(err).toContain("no valid classification");
  });

  it("rejects a missing argument and an unknown interaction", async () => {
    expect(await runEnrich([], { db: testDb.db, err: () => {} })).toBe(2);
    expect((await run("msg-does-not-exist")).code).toBe(2);
  });
});
