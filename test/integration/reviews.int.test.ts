// The review queue's storage and functions (P09) against PostgreSQL. Cases are made by the
// pipeline runner with a scripted model client: no model calls.

import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedCrm } from "../../src/db/crm.js";
import type { Database } from "../../src/db/database.js";
import { processInteraction } from "../../src/pipeline/process.js";
import { byMaskedText, processDeps, scriptedLlm, seed, storeMessage, type Answer } from "../support/pipeline.js";
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
