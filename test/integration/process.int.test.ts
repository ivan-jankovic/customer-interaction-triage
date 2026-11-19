// The pipeline runner (P08) against PostgreSQL with a scripted model client: no model calls.
// Failures in a given step are caused by a temporary constraint or a renamed table in this
// file's own test database, so each step fails with a real database error.

import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCase } from "../../src/db/cases.js";
import { KyselyClassificationStore } from "../../src/db/classifications.js";
import { seedCrm } from "../../src/db/crm.js";
import type { Database } from "../../src/db/database.js";
import { processInteraction, TransientModelError } from "../../src/pipeline/process.js";
import { ROUTER_VERSION } from "../../src/pipeline/route.js";
import { attempt, VALID_CLASSIFICATION } from "../support/attempts.js";
import {
  byMaskedText,
  labelsOf,
  processDeps,
  scriptedLlm,
  seed,
  storeMessage,
  type Answer,
} from "../support/pipeline.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

let testDb: TestDatabase;
let db: Kysely<Database>;

const MSG = "msg-011"; // a technical fault, customer found, outage in its area: auto-routed
const llmFor = (script: Answer[], messageId = MSG) => scriptedLlm(script, byMaskedText([messageId]));
const run = (id: string, llm: ReturnType<typeof llmFor>, finalAttempt = true) =>
  processInteraction(db, processDeps(llm), id, { finalAttempt });

const rows = async (table: "classifications" | "enrichments" | "cases" | "decision_log", id: string) => {
  const r =
    table === "decision_log"
      ? await sql<{ n: string }>`select count(*) as n from decision_log d join cases c on c.id = d.case_id
                                 where c.interaction_id = ${id}`.execute(db)
      : await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} where interaction_id = ${id}`.execute(
          db,
        );
  return Number(r.rows[0]!.n);
};
const statusOf = async (id: string) =>
  (await db.selectFrom("interactions").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;

/** Runs fn with a temporary change to the schema, undone afterwards even when fn throws. */
async function withSchemaChange<T>(apply: string, undo: string, fn: () => Promise<T>): Promise<T> {
  await sql.raw(apply).execute(db);
  try {
    return await fn();
  } finally {
    await sql.raw(undo).execute(db);
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  db = testDb.db;
  await seedCrm(db, seed);
});

afterAll(async () => {
  await testDb?.drop();
});

describe("processInteraction", () => {
  it("runs every step for a fresh interaction and ends with one processed case", async () => {
    const id = await storeMessage(db, MSG);
    const llm = llmFor(["valid"]);
    const r = await run(id, llm, false);
    expect(r.steps).toEqual({ mask: "ran", classify: "ran", enrich: "ran", route: "ran" });
    expect(r.failure).toBeNull();
    expect(r.case).toMatchObject({
      created: true,
      targetTeam: labelsOf(MSG).expected_team,
      needsReview: false,
      routerVersion: ROUTER_VERSION,
    });
    expect(llm.calls).toHaveLength(1);
    expect(await statusOf(id)).toBe("processed");
    expect(await rows("decision_log", id)).toBe(4);
  });

  it("reuses everything on a second run: no model call and no new rows", async () => {
    const id = await storeMessage(db, MSG);
    await run(id, llmFor(["valid"]));
    const before = [await rows("classifications", id), await rows("enrichments", id), await rows("decision_log", id)];
    const llm = llmFor(["valid"]);
    const r = await run(id, llm);
    expect(r.steps).toBeNull();
    expect(r.case.created).toBe(false);
    expect(llm.calls).toHaveLength(0);
    expect([await rows("classifications", id), await rows("enrichments", id), await rows("decision_log", id)]).toEqual(
      before,
    );
  });

  it("resumes from enrich when a valid classification is stored, with no model call", async () => {
    const id = await storeMessage(db, MSG);
    const labels = labelsOf(MSG);
    await new KyselyClassificationStore(db).record(
      id,
      attempt({
        promptVersion: "classify.v2",
        classification: {
          ...VALID_CLASSIFICATION,
          intent: labels.intent,
          fields: { identifiers: [], service_type: labels.fields.service_type, area: labels.fields.area },
        },
      }),
    );
    const llm = llmFor(["valid"]);
    const r = await run(id, llm);
    expect(llm.calls).toHaveLength(0);
    expect(r.steps).toEqual({ mask: "ran", classify: "reused", enrich: "ran", route: "ran" });
  });

  it("stores a transient error and throws for a retry; the next run succeeds with one case", async () => {
    const id = await storeMessage(db, MSG);
    await expect(run(id, llmFor([{ status: 529 }]), false)).rejects.toThrow(TransientModelError);
    expect(await rows("classifications", id)).toBe(1);
    expect(await readCase(db, id)).toBeNull();
    expect(await statusOf(id)).toBe("received");

    const r = await run(id, llmFor(["valid"]), false);
    expect(r.steps).toMatchObject({ mask: "reused", classify: "ran" });
    expect(r.case.reasonCodes).toEqual([]);
    expect(await rows("classifications", id)).toBe(2);
    expect(await rows("cases", id)).toBe(1);
  });

  it.each([
    ["a connection error", null],
    ["a rate limit", 429],
    ["an overload", 529],
  ])("routes %s on the final attempt to review (classification_error)", async (_name, status) => {
    const id = await storeMessage(db, MSG);
    const r = await run(id, llmFor([{ status }]), true);
    expect(r.case).toMatchObject({ targetTeam: "general", needsReview: true, reasonCodes: ["classification_error"] });
    expect(r.steps).toMatchObject({ classify: "ran", enrich: "skipped", route: "ran" });
    expect(await rows("decision_log", id)).toBe(3);
  });

  it.each([
    ["a 400 error", { status: 400 }, "classification_error"],
    ["invalid output", "invalid", "invalid_output"],
  ])("never retries %s: it goes to review on the first attempt", async (_name, answer, code) => {
    const id = await storeMessage(db, MSG);
    const llm = llmFor([answer]);
    const r = await run(id, llm, false);
    expect(r.case.reasonCodes).toEqual([code]);
    expect(llm.calls).toHaveLength(1);
  });

  it("reuses a stored invalid attempt instead of paying again", async () => {
    const id = await storeMessage(db, MSG);
    // An earlier job stored an invalid attempt, then failed before writing the case.
    await withSchemaChange(
      "alter table cases add constraint t_fail check (reason_codes ? 'processing_failed') not valid",
      "alter table cases drop constraint t_fail",
      () => expect(run(id, llmFor(["invalid"]), false)).rejects.toThrow(/t_fail/),
    );
    const llm = llmFor(["valid"]);
    const r = await run(id, llm, false);
    expect(llm.calls).toHaveLength(0);
    expect(r.case.reasonCodes).toEqual(["invalid_output"]);
  });
});

describe("failure cases", () => {
  // Each change makes one step fail with a database error; the failure-case insert still works.
  const failures = [
    {
      step: "mask",
      apply: "alter table interactions add constraint t_fail check (masked_text is null) not valid",
      undo: "alter table interactions drop constraint t_fail",
      classification: false,
      enrichment: false,
      logSteps: ["route"],
    },
    {
      step: "enrich",
      apply: "alter table enrichments add constraint t_fail check (false) not valid",
      undo: "alter table enrichments drop constraint t_fail",
      classification: true,
      enrichment: false,
      logSteps: ["mask", "classify", "route"],
    },
    {
      step: "route",
      apply: "alter table cases add constraint t_fail check (reason_codes ? 'processing_failed') not valid",
      undo: "alter table cases drop constraint t_fail",
      classification: true,
      enrichment: true,
      logSteps: ["mask", "classify", "enrich", "route"],
    },
  ] as const;

  it.each(failures)(
    "writes a processing_failed case when $step fails on the final attempt",
    async ({ step, apply, undo, classification, enrichment, logSteps }) => {
      const id = await storeMessage(db, MSG);
      const r = await withSchemaChange(apply, undo, () => run(id, llmFor(["valid"]), true));
      expect(r.failure).toEqual({ step, errorClass: "DatabaseError" });
      expect(r.case).toMatchObject({
        created: true,
        targetTeam: "general",
        needsReview: true,
        reasonCodes: ["processing_failed"],
        routerVersion: ROUTER_VERSION,
      });
      expect(r.case.classificationId !== null).toBe(classification);
      expect(r.case.enrichmentId !== null).toBe(enrichment);
      expect(r.case.log.map((l) => l.step)).toEqual(logSteps);
      const fired = r.case.log.at(-1)!.output.fired_rules;
      expect(fired).toEqual([{ reason_code: "processing_failed", detail: `failed at ${step}: DatabaseError` }]);
      expect(JSON.stringify(r.case.log)).not.toContain("t_fail"); // no error message is stored
      expect(await statusOf(id)).toBe("processed");
    },
  );

  it("writes a processing_failed case when the model client throws a non-API error", async () => {
    const id = await storeMessage(db, MSG);
    const r = await run(id, llmFor(["throw"]), true);
    expect(r.failure).toEqual({ step: "classify", errorClass: "Error" });
    expect(r.case).toMatchObject({ classificationId: null, enrichmentId: null, reasonCodes: ["processing_failed"] });
    expect(r.case.log.map((l) => l.step)).toEqual(["mask", "route"]);
  });

  it("throws instead, with no case, when it is not the final attempt", async () => {
    const id = await storeMessage(db, MSG);
    await expect(run(id, llmFor(["throw"]), false)).rejects.toThrow("bug in the client");
    expect(await readCase(db, id)).toBeNull();
  });

  it("can't add a failure case next to an existing case", async () => {
    const id = await storeMessage(db, MSG);
    await run(id, llmFor(["valid"]));
    await expect(
      sql`insert into cases (interaction_id, target_team, needs_review, reason_codes, router_version)
                     values (${id}, 'general', true, '["processing_failed"]', 'route.v2')`.execute(db),
    ).rejects.toThrow(/cases_interaction_id_key/);
    expect(await rows("cases", id)).toBe(1);
  });
});
