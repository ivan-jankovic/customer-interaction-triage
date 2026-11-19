// The review queue's storage and functions (P09) against PostgreSQL. Cases are made by the
// pipeline runner with a scripted model client: no model calls.

import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedCrm } from "../../src/db/crm.js";
import { confirmCase, correctCase, InvalidReview, unmaskCase } from "../../src/review/actions.js";
import { readCaseView } from "../../src/review/case-view.js";
import { nextCase, queueSize } from "../../src/review/queue.js";
import type { Database } from "../../src/db/database.js";
import { processInteraction } from "../../src/pipeline/process.js";
import {
  byMaskedText,
  labelsOf,
  processDeps,
  record,
  scriptedLlm,
  seed,
  storeMessage,
  type Answer,
} from "../support/pipeline.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

let testDb: TestDatabase;
let db: Kysely<Database>;

/** Stores a dataset message and processes it; returns the case ID. */
async function makeCase(messageId: string, answer: Answer = "valid"): Promise<string> {
  const id = await storeMessage(db, messageId);
  const r = await processInteraction(db, processDeps(scriptedLlm([answer], byMaskedText([messageId]))), id, {
    finalAttempt: true,
  });
  return r.case.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  db = testDb.db;
  await seedCrm(db, seed);
});

afterAll(async () => {
  await testDb?.drop();
});

describe("reviews and unmask_log constraints", () => {
  const insertReview = (caseId: string, columns: string, values: string) =>
    sql.raw(`insert into reviews (case_id, spot_check, ${columns}) values ('${caseId}', false, ${values})`).execute(db);

  it("accepts a confirmation and a correction", async () => {
    await expect(
      insertReview(await makeCase("msg-013"), "reviewer, decision", "'reviewer-1', 'confirmed'"),
    ).resolves.toBeDefined();
    await expect(
      insertReview(
        await makeCase("msg-013"),
        "reviewer, decision, corrected_intent, corrected_team, note",
        "'reviewer-1', 'corrected', 'complaint', 'complaints', 'angry, not leaving'",
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a second review of a case", async () => {
    const caseId = await makeCase("msg-013");
    await insertReview(caseId, "reviewer, decision", "'reviewer-1', 'confirmed'");
    await expect(insertReview(caseId, "reviewer, decision", "'reviewer-2', 'confirmed'")).rejects.toThrow(
      /reviews_case_id_key/,
    );
  });

  it.each([
    ["a bad handle", "reviewer, decision", "'Jan Novák', 'confirmed'", /reviews_reviewer_check/],
    ["an unknown decision", "reviewer, decision", "'reviewer-1', 'maybe'", /reviews_(decision|correction)_check/],
    [
      "a correction without a note",
      "reviewer, decision, corrected_intent, corrected_team",
      "'reviewer-1', 'corrected', 'complaint', 'complaints'",
      /reviews_correction_check/,
    ],
    [
      "a correction without a team",
      "reviewer, decision, corrected_intent, note",
      "'reviewer-1', 'corrected', 'complaint', 'n'",
      /reviews_correction_check/,
    ],
    [
      "a confirmation with corrected values",
      "reviewer, decision, corrected_intent, corrected_team",
      "'reviewer-1', 'confirmed', 'complaint', 'complaints'",
      /reviews_correction_check/,
    ],
    [
      "an unknown intent",
      "reviewer, decision, corrected_intent, corrected_team, note",
      "'reviewer-1', 'corrected', 'refund', 'billing', 'n'",
      /reviews_corrected_intent_check/,
    ],
    [
      "an unknown team",
      "reviewer, decision, corrected_intent, corrected_team, note",
      "'reviewer-1', 'corrected', 'other', 'legal', 'n'",
      /reviews_corrected_team_check/,
    ],
  ])("rejects %s", async (_name, columns, values, error) => {
    await expect(insertReview(await makeCase("msg-013"), columns, values)).rejects.toThrow(error);
  });

  it("rejects a too-short unmask reason and a bad handle", async () => {
    const caseId = await makeCase("msg-013");
    await expect(
      sql`insert into unmask_log (case_id, reviewer, reason) values (${caseId}, 'reviewer-1', 'ok')`.execute(db),
    ).rejects.toThrow(/unmask_log_reason_check/);
    await expect(
      sql`insert into unmask_log (case_id, reviewer, reason) values (${caseId}, 'X', 'to call back')`.execute(db),
    ).rejects.toThrow(/unmask_log_reviewer_check/);
  });
});

describe("queue", () => {
  // A fresh set of cases; earlier describes' cases are reviewed or excluded below.
  let cases: Record<string, string>;
  beforeAll(async () => {
    await sql`truncate reviews, unmask_log`.execute(db);
    await sql`delete from decision_log`.execute(db);
    await sql`delete from cases`.execute(db);
    cases = {
      auto: await makeCase("msg-011"), // found, auto-routed
      cancellation: await makeCase("msg-013"),
      ambiguous: await makeCase("msg-022"),
      unidentified: await makeCase("msg-007"),
    };
  });

  it("holds pending cases by default and auto-routed ones with spotCheck, oldest first", async () => {
    expect(await nextCase(db)).toBe(cases.cancellation);
    expect(await queueSize(db)).toBe(3);
    expect(await nextCase(db, { spotCheck: true })).toBe(cases.auto);
    expect(await queueSize(db, { spotCheck: true })).toBe(1);
  });

  it("narrows by team and reason code, and leaves out excluded cases", async () => {
    expect(await nextCase(db, { team: "technical_support" })).toBe(cases.unidentified);
    expect(await nextCase(db, { reason: "customer_ambiguous" })).toBe(cases.ambiguous);
    expect(await queueSize(db, { reason: "cancellation" })).toBe(1);
    expect(await nextCase(db, { exclude: [cases.cancellation!] })).toBe(cases.ambiguous);
  });

  it("drops a case once it is reviewed", async () => {
    await confirmCase(db, cases.cancellation!, { reviewer: "reviewer-1" });
    expect(await nextCase(db)).toBe(cases.ambiguous);
    expect(await queueSize(db)).toBe(2);
  });
});

describe("case view", () => {
  const noIdentifierValues = (messageId: string, view: unknown) => {
    const text = JSON.stringify(view);
    for (const i of labelsOf(messageId).fields.identifiers) expect(text, messageId).not.toContain(i.value);
  };

  it("shows a found customer with services and outages, and the masked text only", async () => {
    const view = await readCaseView(db, await makeCase("msg-011"));
    expect(view.customer?.id).toBe(seed.messages.find((m) => m.message_id === "msg-011")!.expected.customer_id);
    expect(view.customer?.services.length).toBeGreaterThan(0);
    expect(view.customer).not.toHaveProperty("customer_number");
    expect(view.outages.length).toBeGreaterThan(0);
    expect(view.classification?.outcome).toBe("valid");
    expect(view.interaction.maskedText).toContain("[");
    expect(view.interaction).not.toHaveProperty("rawText");
    expect(view.case.log.map((l) => l.step)).toEqual(["mask", "classify", "enrich", "route"]);
    noIdentifierValues("msg-011", view);
  });

  it("shows the candidates of an ambiguous customer", async () => {
    const view = await readCaseView(db, await makeCase("msg-022"));
    expect(view.enrichment?.outcome).toBe("ambiguous");
    expect(view.enrichment?.candidates.length).toBeGreaterThan(1);
    expect(view.customer).toBeNull();
    noIdentifierValues("msg-022", view);
  });

  it("shows unmatched placeholders of a customer not found", async () => {
    const view = await readCaseView(db, await makeCase("msg-001"));
    expect(view.enrichment?.outcome).toBe("not_found");
    expect(view.enrichment?.unmatchedPlaceholders.length).toBeGreaterThan(0);
    noIdentifierValues("msg-001", view);
  });

  it("shows a processing_failed case without masked text or classification", async () => {
    const id = await storeMessage(db, "msg-011");
    await sql`alter table interactions add constraint t_fail check (masked_text is null) not valid`.execute(db);
    let caseId: string;
    try {
      const r = await processInteraction(db, processDeps(scriptedLlm(["valid"], byMaskedText(["msg-011"]))), id, {
        finalAttempt: true,
      });
      caseId = r.case.id;
    } finally {
      await sql`alter table interactions drop constraint t_fail`.execute(db);
    }
    const view = await readCaseView(db, caseId);
    expect(view.case.reasonCodes).toEqual(["processing_failed"]);
    expect(view.interaction.maskedText).toBeNull();
    expect(view.classification).toBeNull();
    expect(view.enrichment).toBeNull();
  });
});

describe("actions", () => {
  it("confirms a pending case, with the reviewer and note, and spot_check false", async () => {
    const caseId = await makeCase("msg-013");
    const r = await confirmCase(db, caseId, { reviewer: "reviewer-1", note: " fine " });
    expect(r).toMatchObject({
      stored: true,
      review: { caseId, reviewer: "reviewer-1", decision: "confirmed", note: "fine", spotCheck: false },
    });
  });

  it("corrects a case and records a spot check of an auto-routed one", async () => {
    const caseId = await makeCase("msg-011");
    const r = await correctCase(db, caseId, {
      reviewer: "reviewer-2",
      intent: "complaint",
      team: "complaints",
      note: "the customer is complaining about repeated outages",
    });
    expect(r).toMatchObject({
      stored: true,
      review: { decision: "corrected", correctedIntent: "complaint", correctedTeam: "complaints", spotCheck: true },
    });
  });

  it("refuses invalid input and stores nothing", async () => {
    const caseId = await makeCase("msg-013");
    const labels = labelsOf("msg-013");
    await expect(confirmCase(db, caseId, { reviewer: "Jan" })).rejects.toThrow(InvalidReview);
    await expect(
      correctCase(db, caseId, { reviewer: "reviewer-1", intent: "complaint", team: "complaints", note: "" }),
    ).rejects.toThrow(/note/);
    await expect(
      correctCase(db, caseId, {
        reviewer: "reviewer-1",
        intent: labels.intent,
        team: labels.expected_team,
        note: "same",
      }),
    ).rejects.toThrow(/confirm/);
    expect((await readCaseView(db, caseId)).review).toBeNull();
  });

  it("keeps the first review when a second comes, one after the other or concurrently", async () => {
    const caseId = await makeCase("msg-013");
    await confirmCase(db, caseId, { reviewer: "reviewer-1" });
    const second = await correctCase(db, caseId, {
      reviewer: "reviewer-2",
      intent: "complaint",
      team: "complaints",
      note: "n",
    });
    expect(second).toMatchObject({ stored: false, existing: { reviewer: "reviewer-1", decision: "confirmed" } });

    const raced = await makeCase("msg-013");
    const results = await Promise.all([
      confirmCase(db, raced, { reviewer: "reviewer-1" }),
      confirmCase(db, raced, { reviewer: "reviewer-2" }),
    ]);
    expect(results.filter((r) => r.stored)).toHaveLength(1);
    const n = await sql<{ n: string }>`select count(*) as n from reviews where case_id = ${raced}`.execute(db);
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it("logs an unmask before returning the raw text, and the case view lists it", async () => {
    const caseId = await makeCase("msg-001");
    await expect(unmaskCase(db, caseId, { reviewer: "reviewer-1", reason: "" })).rejects.toThrow(InvalidReview);
    const raw = await unmaskCase(db, caseId, { reviewer: "reviewer-1", reason: "search the CRM by phone" });
    expect(raw).toBe(record("msg-001").text);
    const view = await readCaseView(db, caseId);
    expect(view.unmaskings).toMatchObject([{ reviewer: "reviewer-1", reason: "search the CRM by phone" }]);
  });
});
