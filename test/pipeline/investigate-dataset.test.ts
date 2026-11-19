// The seed's designed likely causes (P10 validation.md, "Storage and seed"): the 17 technical
// faults get the causes in requirements.md, and a simple reference check over the seed (no
// model, no agent) finds each designed cause in the data the tools will read. If the
// generator's line status or outages drift from the design, this fails before any paid run.

import { describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import { memoryCrm } from "../../src/pipeline/crm-memory.js";
import { enrich } from "../../src/pipeline/enrich.js";
import { mask } from "../../src/pipeline/mask.js";
import type { LikelyCause } from "../../src/taxonomy.js";

const seed = readCrmSeed();
const crm = memoryCrm(seed);
const dataset = readJsonl<DatasetRecord>(PATHS.dataset);
const labelsOf = (r: DatasetRecord) => r.final ?? r.chosen;
const faults = dataset.filter((r) => labelsOf(r).intent === "technical_fault");
const message = (id: string) => seed.messages.find((m) => m.message_id === id)!;

/** requirements.md, "The seed". */
const DESIGNED: Record<string, LikelyCause> = {
  "msg-007": "inconclusive",
  "msg-011": "area_outage",
  "msg-012": "area_outage",
  "msg-017": "inconclusive",
  "msg-018": "area_outage",
  "msg-021": "inconclusive",
  "msg-029": "area_outage",
  "msg-036": "inconclusive",
  "msg-037": "area_outage",
  "msg-051": "area_outage",
  "msg-056": "area_outage",
  "msg-063": "inconclusive",
  "msg-069": "service_inactive",
  "msg-071": "line_fault",
  "msg-078": "inconclusive",
  "msg-079": "inconclusive",
  "msg-084": "area_outage",
};

/** What the data says, read the way the tools read it; independent of the generator's lists. */
async function referenceCause(r: DatasetRecord): Promise<LikelyCause> {
  const labels = labelsOf(r);
  const m = message(r.id);
  const at = new Date(m.received_at);
  const type = labels.fields.service_type === "unknown" ? null : labels.fields.service_type;
  const enrichment = await enrich(
    {
      identifiers: mask(r.text).identifiers,
      area: labels.fields.area,
      serviceType: labels.fields.service_type,
      receivedAt: at,
    },
    crm,
  );
  if (enrichment.area) {
    const ongoing = (await crm.outagesInArea(enrichment.area, type, at, 7)).filter(
      (o) => o.resolvedAt === null || o.resolvedAt > at,
    );
    if (ongoing.length > 0) return "area_outage";
  }
  const lines = [];
  for (const c of enrichment.candidates) {
    for (const l of await crm.lineStatusOfCustomer(c.customerId)) {
      if (type === null || l.serviceType === type) lines.push({ customer: c.customerId, ...l });
    }
  }
  if (enrichment.outcome === "found") {
    const active = lines.filter((l) => l.status === "active");
    if (active.length === 0 && lines.length > 0) return "service_inactive";
    if (active.some((l) => l.state === "down" || l.state === "degraded")) return "line_fault";
    if (active.length > 0) return "customer_equipment";
  }
  if (enrichment.outcome === "ambiguous") {
    // A number that moved: one candidate's service is terminated, another's holds it now.
    const terminated = new Set(lines.filter((l) => l.status === "terminated").map((l) => l.customer));
    const active = new Set(lines.filter((l) => l.status === "active").map((l) => l.customer));
    if ([...terminated].some((c) => !active.has(c)) && active.size > 0) return "service_inactive";
  }
  return "inconclusive";
}

describe("designed likely causes", () => {
  it("are set for the 17 technical faults exactly, as in requirements.md", () => {
    const designed = Object.fromEntries(
      seed.messages.filter((m) => m.expected_cause !== null).map((m) => [m.message_id, m.expected_cause]),
    );
    expect(designed).toEqual(DESIGNED);
    expect(faults.map((r) => r.id).sort()).toEqual(Object.keys(DESIGNED).sort());
  });

  it.each(faults.map((r) => [r.id, r] as const))("%s: the reference check finds the designed cause", async (id, r) => {
    expect(await referenceCause(r), message(id).design).toBe(DESIGNED[id]);
  });

  it("give every service a line-status row; a terminated service's line is down", () => {
    expect(seed.line_status.map((l) => l.service_id).sort()).toEqual(seed.services.map((s) => s.id).sort());
    for (const s of seed.services.filter((x) => x.status === "terminated")) {
      expect(seed.line_status.find((l) => l.service_id === s.id)!.state).toBe("down");
    }
  });

  it("keep identifier values out of line diagnostics and ticket summaries", () => {
    const values = [
      ...seed.customers.flatMap((c) => [c.customer_number, c.email]),
      ...seed.services.flatMap((s) => [s.contract_number, s.phone]),
    ].filter((v): v is string => v !== null);
    const texts = [...seed.line_status.map((l) => l.diagnostic), ...seed.tickets.map((t) => t.summary)];
    for (const text of texts) {
      for (const v of values) expect(text.includes(v), `${v} in "${text}"`).toBe(false);
      expect(text).not.toMatch(/MR\d{8}|SML-\d{4}|\+42[01]|@/);
    }
  });
});
