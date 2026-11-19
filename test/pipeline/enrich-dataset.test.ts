// Enriching every dataset message against the seeded CRM, in memory (free, no model, no
// database): the rules in src/pipeline/enrich.ts must give exactly what the seed generator
// designed for each message (P06 validation.md, "Seed").

import { describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { enrich } from "../../src/pipeline/enrich.js";
import { mask } from "../../src/pipeline/mask.js";

const seed = readCrmSeed();
const crm = memoryCrm(seed);
const dataset = readJsonl<DatasetRecord>(PATHS.dataset);
const injection = readJsonl<DatasetRecord>(PATHS.injection);
const labelsOf = (r: DatasetRecord) => r.final ?? r.chosen;
const message = (id: string) => seed.messages.find((m) => m.message_id === id)!;

describe("enriching the dataset", () => {
  it("has a seed entry for every dataset message", () => {
    expect(seed.messages.map((m) => m.message_id).sort()).toEqual(dataset.map((r) => r.id).sort());
  });

  it.each(dataset.map((r) => [r.id, r] as const))("%s: enrichment equals the designed expectation", async (id, r) => {
    const labels = labelsOf(r);
    const m = message(id);
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
      m.design,
    ).toEqual(m.expected);
  });

  it("covers every path the spec asks for", () => {
    const outcomes = seed.messages.map((m) => m.expected.outcome);
    const count = (o: string) => outcomes.filter((x) => x === o).length;
    expect(count("not_found")).toBeGreaterThanOrEqual(3);
    expect(count("ambiguous")).toBeGreaterThanOrEqual(3);
    expect(count("found")).toBeGreaterThan(30);
    expect(seed.messages.filter((m) => m.design.includes("unknown to the CRM")).length).toBeGreaterThanOrEqual(2);
    expect(seed.messages.filter((m) => m.expected.area_source === "customer").length).toBeGreaterThan(0);

    const faultsWithArea = dataset.filter(
      (r) => labelsOf(r).intent === "technical_fault" && labelsOf(r).fields.area !== null,
    );
    expect(faultsWithArea).toHaveLength(15);
    const withOutage = faultsWithArea.filter((r) => message(r.id).expected.outage_ids.length > 0);
    expect(withOutage.length).toBeGreaterThanOrEqual(6);
    expect(withOutage.length).toBeLessThanOrEqual(9);
    expect(seed.messages.filter((m) => /resolved before|another service type/.test(m.design)).length).toBeGreaterThan(
      0,
    );
  });

  it.each(injection.map((r) => [r.id, r] as const))(
    "%s: an injection message enriches without error, finding nobody",
    async (_id, r) => {
      const result = await enrich(
        {
          identifiers: mask(r.text).identifiers,
          area: labelsOf(r).fields.area,
          serviceType: labelsOf(r).fields.service_type,
          receivedAt: new Date("2026-11-04T10:00:00Z"),
        },
        crm,
      );
      expect(["not_found", "no_identifiers"]).toContain(result.outcome);
    },
  );
});
