// The routing step with storage, and the route CLI (P07), on dataset messages stored the way the
// pipeline stores them: interaction with the seed's received_at, masking, a classification
// carrying the labelled intent, area and service type, its enrichment and, for a technical
// fault, an investigation attempt (P10) (no model is called).

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { runRoute } from "../../src/cli/route.js";
import { NotReadyForRouting, readCase, routeInteraction } from "../../src/db/cases.js";
import { KyselyClassificationStore } from "../../src/db/classifications.js";
import { seedCrm } from "../../src/db/crm.js";
import { readCrmSeed } from "../../src/db/crm-seed.js";
import { enrichInteraction } from "../../src/db/enrichments.js";
import { maskInteraction } from "../../src/db/masking.js";
import { ROUTER_VERSION } from "../../src/pipeline/route.js";
import { latestEnrichmentFor } from "../../src/db/enrichments.js";
import { recordInvestigation } from "../../src/db/investigations.js";
import type { InvestigationAttempt } from "../../src/pipeline/investigate.js";
import {
  attempt,
  errorAttempt,
  inconclusiveInvestigation,
  invalidAttempt,
  investigationAttempt,
  VALID_CLASSIFICATION,
} from "../support/attempts.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const seed = readCrmSeed();
const dataset = readJsonl<DatasetRecord>(PATHS.dataset);
let testDb: TestDatabase;

const record = (messageId: string) => dataset.find((x) => x.id === messageId)!;
const labelsOf = (messageId: string) => {
  const r = record(messageId);
  return r.final ?? r.chosen;
};

const labelledAttempt = (messageId: string, confidence = 0.9) => {
  const labels = labelsOf(messageId);
  return attempt({
    promptVersion: "classify.v2",
    classification: {
      ...VALID_CLASSIFICATION,
      intent: labels.intent,
      confidence,
      fields: { identifiers: [], service_type: labels.fields.service_type, area: labels.fields.area },
    },
  });
};

/**
 * Stores a dataset message as the pipeline would: masked, classified with its labels, enriched,
 * and for a technical fault investigated (`investigation`, conclusive by default; null for none).
 */
async function store(
  messageId: string,
  {
    classify = true,
    enrich = true,
    confidence = 0.9,
    investigation = investigationAttempt(),
  }: { classify?: boolean; enrich?: boolean; confidence?: number; investigation?: InvestigationAttempt | null } = {},
): Promise<string> {
  const r = record(messageId);
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
  await maskInteraction(testDb.db, id);
  if (classify) await new KyselyClassificationStore(testDb.db).record(id, labelledAttempt(messageId, confidence));
  if (classify && enrich) {
    const e = await enrichInteraction(testDb.db, id);
    if (investigation && labelsOf(messageId).intent === "technical_fault") {
      await recordInvestigation(
        testDb.db,
        { interactionId: id, classificationId: e.classificationId!, enrichmentId: e.id },
        investigation,
      );
    }
  }
  return id;
}

const count = async (table: "cases" | "decision_log") =>
  Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(testDb.db)).rows[0]!.n);

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  await seedCrm(testDb.db, seed);
});

afterAll(async () => {
  await testDb?.drop();
});

describe("routeInteraction", () => {
  it("writes an auto-routed case with one log entry per step", async () => {
    const id = await store("msg-011");
    const c = await routeInteraction(testDb.db, id);
    const classification = await new KyselyClassificationStore(testDb.db).latestValid(id);
    expect(c).toMatchObject({
      created: true,
      interactionId: id,
      classificationId: classification!.id,
      customerId: seed.messages.find((m) => m.message_id === "msg-011")!.expected.customer_id,
      targetTeam: labelsOf("msg-011").expected_team,
      needsReview: false,
      reasonCodes: [],
      routerVersion: ROUTER_VERSION,
    });
    expect(c.enrichmentId).not.toBeNull();
    expect(c.log.map((l) => [l.seq, l.step, l.ruleApplied])).toEqual([
      [1, "mask", "mask.v1"],
      [2, "classify", "classify.v2 / claude-opus-5-5"],
      [3, "enrich", "enrich.v1"],
      [4, "investigate", "investigate.v1 / claude-opus-5-5"],
      [5, "route", ROUTER_VERSION],
    ]);
    expect(c.log[2]!.output).toMatchObject({ outcome: "found", customer_id: c.customerId });
    expect(c.log[3]!.output).toEqual({
      outcome: "valid",
      likely_cause: "area_outage",
      confidence: 0.9,
      steps: 2,
      tools_called: ["check_outages"],
      tool_errors: 0,
    });
    expect(c.log[4]!.output).toEqual({ target_team: c.targetTeam, needs_review: false, fired_rules: [] });
    const { created: _created, ...stored } = c;
    expect(await readCase(testDb.db, id)).toEqual(stored);
    const { status } = await testDb.db
      .selectFrom("interactions")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(status).toBe("processed");
  });

  it("leaves the status received when routing fails", async () => {
    const id = await store("msg-011", { enrich: false });
    await expect(routeInteraction(testDb.db, id)).rejects.toThrow(NotReadyForRouting);
    const { status } = await testDb.db
      .selectFrom("interactions")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(status).toBe("received");
  });

  it("keeps every reason of a review case, in order, with details", async () => {
    // msg-055: a found customer, its [PHONE_1] matches no one; classified with low confidence.
    const c = await routeInteraction(testDb.db, await store("msg-055", { confidence: 0.5 }));
    expect(c.needsReview).toBe(true);
    expect(c.reasonCodes).toEqual(["low_confidence", "crm_mismatch_unmatched_key"]);
    expect(c.log[4]!.output).toMatchObject({
      needs_review: true,
      fired_rules: [
        { reason_code: "low_confidence", detail: "confidence 0.5 < 0.7" },
        { reason_code: "crm_mismatch_unmatched_key", detail: "[PHONE_1] matched no customer" },
      ],
    });
  });

  it.each([
    ["invalid", invalidAttempt, "invalid_output"],
    ["errored", errorAttempt, "classification_error"],
  ] as const)("routes an %s classification to general for review, without enrichment", async (_n, make, code) => {
    const id = await store("msg-011", { classify: false });
    await new KyselyClassificationStore(testDb.db).record(id, make());
    const c = await routeInteraction(testDb.db, id);
    expect(c).toMatchObject({ targetTeam: "general", needsReview: true, reasonCodes: [code], enrichmentId: null });
    expect(c.log.map((l) => l.step)).toEqual(["mask", "classify", "route"]);
  });

  it("uses the latest valid classification over a newer invalid one", async () => {
    const id = await store("msg-011");
    await new KyselyClassificationStore(testDb.db).record(id, invalidAttempt());
    const c = await routeInteraction(testDb.db, id);
    expect(c.reasonCodes).toEqual([]);
    expect(c.classificationId).toBe((await new KyselyClassificationStore(testDb.db).latestValid(id))!.id);
  });

  it("is idempotent: a second call returns the same case and writes nothing", async () => {
    const id = await store("msg-022");
    const first = await routeInteraction(testDb.db, id);
    const [cases, log] = [await count("cases"), await count("decision_log")];
    const second = await routeInteraction(testDb.db, id);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect([await count("cases"), await count("decision_log")]).toEqual([cases, log]);
  });

  it("gives one case when two calls race", async () => {
    const id = await store("msg-097");
    const results = await Promise.all([routeInteraction(testDb.db, id), routeInteraction(testDb.db, id)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await testDb.db.selectFrom("decision_log").select("id").where("case_id", "=", results[0].id).execute();
    expect(rows).toHaveLength(5);
  });

  it("fails clearly, storing nothing, when classification or enrichment is missing", async () => {
    const before = await count("cases");
    await expect(routeInteraction(testDb.db, await store("msg-011", { classify: false }))).rejects.toThrow(
      /classify first/,
    );
    await expect(routeInteraction(testDb.db, await store("msg-011", { enrich: false }))).rejects.toThrow(
      NotReadyForRouting,
    );
    expect(await count("cases")).toBe(before);
  });

  it("does not use an enrichment made from an older classification", async () => {
    const id = await store("msg-011");
    await new KyselyClassificationStore(testDb.db).record(id, labelledAttempt("msg-011"));
    await expect(routeInteraction(testDb.db, id)).rejects.toThrow(/enrich first/);
  });

  // P10: the investigation.
  it("refuses to route a valid technical fault without an investigation, storing nothing", async () => {
    const before = await count("cases");
    const id = await store("msg-011", { investigation: null });
    await expect(routeInteraction(testDb.db, id)).rejects.toThrow(/investigate first/);
    expect(await count("cases")).toBe(before);
  });

  it("sends a fault with an inconclusive investigation to review, keeping its team", async () => {
    const c = await routeInteraction(testDb.db, await store("msg-011", { investigation: inconclusiveInvestigation() }));
    expect(c).toMatchObject({
      targetTeam: "technical_support",
      needsReview: true,
      reasonCodes: ["investigation_inconclusive"],
    });
    expect(c.log[4]!.output).toMatchObject({
      fired_rules: [{ reason_code: "investigation_inconclusive", detail: "investigation found no likely cause" }],
    });
  });

  it("routes with the latest investigation of the enrichment, and names it in the log", async () => {
    const id = await store("msg-011", { investigation: inconclusiveInvestigation() });
    const e = (await latestEnrichmentFor(
      testDb.db,
      id,
      (await new KyselyClassificationStore(testDb.db).latestValid(id))!.id,
    ))!;
    const latest = await recordInvestigation(
      testDb.db,
      { interactionId: id, classificationId: e.classificationId!, enrichmentId: e.id },
      investigationAttempt(),
    );
    const c = await routeInteraction(testDb.db, id);
    expect(c.reasonCodes).toEqual([]);
    expect(c.log[3]!.inputSummary).toMatchObject({ investigation_id: latest.id, enrichment_id: e.id });
    expect(c.log[4]!.inputSummary).toMatchObject({ investigation_id: latest.id });
  });

  it("logs the investigate step as skipped for a case that isn't a technical fault", async () => {
    const c = await routeInteraction(testDb.db, await store("msg-022"));
    expect(c.log.map((l) => l.step)).toEqual(["mask", "classify", "enrich", "investigate", "route"]);
    expect(c.log[3]!.output).toEqual({ skipped: `intent ${labelsOf("msg-022").intent} is not a technical fault` });
  });

  it("writes no message text, summary or identifier value to the decision log", async () => {
    for (const messageId of ["msg-011", "msg-055", "msg-022", "msg-014"]) {
      const c = await routeInteraction(testDb.db, await store(messageId));
      const log = JSON.stringify(c.log);
      for (const i of labelsOf(messageId).fields.identifiers) expect(log, messageId).not.toContain(i.value);
      expect(log).not.toContain(VALID_CLASSIFICATION.summary);
      // Nor the investigation's summary, evidence or tool results (P10).
      expect(log).not.toContain(investigationAttempt().summary!);
      expect(log).not.toContain("TOOL-RESULT-TEXT");
      expect(log).not.toContain(investigationAttempt().evidence[0]!.finding);
      expect(log).not.toContain(record(messageId).text.slice(0, 30));
    }
  });
});

describe("cases constraints", () => {
  const insert = async (values: { team?: string; needsReview?: boolean; codes?: string; interactionId?: string }) => {
    const interactionId = values.interactionId ?? (await store("msg-007", { enrich: false }));
    const classificationId = (await new KyselyClassificationStore(testDb.db).latestValid(interactionId))!.id;
    return sql`insert into cases (interaction_id, classification_id, target_team, needs_review, reason_codes, router_version)
               values (${interactionId}, ${classificationId}, ${values.team ?? "general"}, ${values.needsReview ?? true},
                       ${values.codes ?? '["low_confidence"]'}::jsonb, 'route.v1')`.execute(testDb.db);
  };

  it("accepts a consistent row", async () => {
    await expect(insert({})).resolves.toBeDefined();
    await expect(insert({ needsReview: false, codes: "[]" })).resolves.toBeDefined();
  });

  it.each([
    ["needs_review without a reason", { needsReview: true, codes: "[]" }, /cases_needs_review_check/],
    ["reasons without needs_review", { needsReview: false }, /cases_needs_review_check/],
    ["an unknown team", { team: "legal" }, /cases_target_team_check/],
  ])("rejects %s", async (_name, values, error) => {
    await expect(insert(values)).rejects.toThrow(error);
  });

  it("rejects a second case for the same interaction", async () => {
    const interactionId = await store("msg-007", { enrich: false });
    await insert({ interactionId });
    await expect(insert({ interactionId })).rejects.toThrow(/cases_interaction_id_key/);
  });
});

describe("npm run route", () => {
  const run = async (ref: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runRoute([ref], { db: testDb.db, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const externalId = async (id: string) =>
    (await testDb.db.selectFrom("interactions").select("external_id").where("id", "=", id).executeTakeFirstOrThrow())
      .external_id!;

  it("prints an auto-routed case and its decision log", async () => {
    const { code, out } = await run(await externalId(await store("msg-011")));
    expect(code).toBe(0);
    expect(out).toContain(`Team: ${labelsOf("msg-011").expected_team}`);
    expect(out).toContain("Review: no");
    expect(out).toMatch(/1\. mask +\(mask\.v1\) placeholders: \[/);
    expect(out).toMatch(/3\. enrich +\(enrich\.v1\) found;/);
    expect(out).toMatch(
      /4\. investigate +\(investigate\.v1 \/ claude-opus-5-5\) valid; cause area_outage, confidence 0\.9, 2 turns, tools check_outages/,
    );
    expect(out).toMatch(/5\. route +\(route\.v3\) team /);
    expect(out).not.toContain("existing case");
  });

  it("prints the reasons of a review case, and no identifier values", async () => {
    const id = await store("msg-055", { confidence: 0.5 });
    const { code, out } = await run(id);
    expect(code).toBe(0);
    expect(out).toContain("Review: yes");
    expect(out).toContain("- low_confidence: confidence 0.5 < 0.7");
    expect(out).toContain("- crm_mismatch_unmatched_key: [PHONE_1] matched no customer");
    for (const i of labelsOf("msg-055").fields.identifiers) expect(out).not.toContain(i.value);
  });

  it("says so when the case already existed", async () => {
    const id = await store("msg-022");
    await run(id);
    expect((await run(id)).out).toContain("existing case");
  });

  it("explains what is missing, and rejects bad arguments", async () => {
    const { code, err } = await run(await store("msg-011", { enrich: false }));
    expect(code).toBe(1);
    expect(err).toContain("enrich first");
    expect(await runRoute([], { db: testDb.db, err: () => {} })).toBe(2);
    expect((await run("msg-does-not-exist")).code).toBe(2);
  });
});
