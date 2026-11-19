// The interactive review loop (P09) driven by scripted input against PostgreSQL. The driver
// answers each prompt as it appears, so an answer can do something first (another reviewer
// storing a review while the case is on screen). Cases come from the pipeline runner with a
// scripted model client: no model calls.

import { PassThrough, Writable } from "node:stream";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedCrm } from "../../src/db/crm.js";
import type { Database } from "../../src/db/database.js";
import { processInteraction } from "../../src/pipeline/process.js";
import { confirmCase } from "../../src/review/actions.js";
import { runReview } from "../../src/review/cli.js";
import { nextCase } from "../../src/review/queue.js";
import { INTENTS, TEAMS, type Intent, type Team } from "../../src/taxonomy.js";
import { byMaskedText, labelsOf, processDeps, record, scriptedLlm, seed, storeMessage } from "../support/pipeline.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

let testDb: TestDatabase;
let db: Kysely<Database>;

const intentNo = (i: Intent) => String(INTENTS.indexOf(i) + 1);
const teamNo = (t: Team) => String(TEAMS.indexOf(t) + 1);

async function makeCase(messageId: string): Promise<string> {
  const id = await storeMessage(db, messageId);
  const r = await processInteraction(db, processDeps(scriptedLlm(["valid"], byMaskedText([messageId]))), id, {
    finalAttempt: true,
  });
  return r.case.id;
}

type Answer = string | (() => Promise<string>);

/** Runs the loop; each prompt (output ending in "> " or ": ") gets the next answer, then end of input. */
async function drive(argv: string[], answers: Answer[], env: NodeJS.ProcessEnv = {}) {
  const input = new PassThrough();
  const queue = [...answers];
  let out = "";
  const output = new Writable({
    write(chunk: Buffer, _enc, done) {
      const text = chunk.toString();
      out += text;
      if (/(> |: )$/.test(text)) {
        const next = queue.shift();
        if (next === undefined) input.end();
        else void Promise.resolve(typeof next === "function" ? next() : next).then((line) => input.write(`${line}\n`));
      }
      done();
    },
  });
  const code = await runReview(argv, { db, env, input, output });
  return { code, out, unused: queue.length };
}

const reviewOf = async (caseId: string) =>
  db.selectFrom("reviews").selectAll().where("case_id", "=", caseId).executeTakeFirst();

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  db = testDb.db;
  await seedCrm(db, seed);
});

beforeEach(async () => {
  await sql`delete from unmask_log`.execute(db);
  await sql`delete from reviews`.execute(db);
  await sql`delete from decision_log`.execute(db);
  await sql`delete from cases`.execute(db);
});

afterAll(async () => {
  await testDb?.drop();
});

const ME = ["--reviewer", "reviewer-1"];

describe("npm run review", () => {
  it("confirms with a note, then shows the next case", async () => {
    const first = await makeCase("msg-013");
    const second = await makeCase("msg-014");
    const { code, out } = await drive(ME, ["c", "looks right", "q"]);
    expect(code).toBe(0);
    expect(out).toContain(`Case 1 of 2  ${first}`);
    expect(out).toContain("Confirmed by reviewer-1.");
    expect(out).toContain(`Case 2 of 2  ${second}`);
    expect(out).toContain("Session: 1 confirmed, 0 corrected, 0 skipped, 0 unmasked.");
    expect(await reviewOf(first)).toMatchObject({ reviewer: "reviewer-1", decision: "confirmed", note: "looks right" });
    expect(await reviewOf(second)).toBeUndefined();
  });

  it("corrects to a new intent with the default team", async () => {
    const caseId = await makeCase("msg-013"); // cancellation → retention
    const { out } = await drive(ME, ["r", intentNo("complaint"), "", "angry about the price, not leaving"]);
    expect(out).toContain("Corrected to complaint / complaints by reviewer-1.");
    expect(await reviewOf(caseId)).toMatchObject({
      decision: "corrected",
      corrected_intent: "complaint",
      corrected_team: "complaints",
      note: "angry about the price, not leaving",
      spot_check: false,
    });
  });

  it("corrects only the team", async () => {
    const caseId = await makeCase("msg-013");
    await drive(ME, ["r", intentNo("cancellation"), teamNo("billing"), "the contract has a billing dispute first"]);
    expect(await reviewOf(caseId)).toMatchObject({ corrected_intent: "cancellation", corrected_team: "billing" });
  });

  it("asks again for a missing note, and refuses a correction that changes nothing", async () => {
    const noted = await makeCase("msg-013");
    const unchanged = await makeCase("msg-014"); // also cancellation → retention
    const { out } = await drive(ME, [
      "r",
      intentNo("complaint"),
      "",
      "",
      "now with a note",
      // second case: its own intent and team
      "r",
      intentNo("cancellation"),
      "",
      "same as before",
      "q",
    ]);
    expect(out).toContain("A correction needs a note saying why.");
    expect(await reviewOf(noted)).toMatchObject({ note: "now with a note" });
    expect(out).toContain("That is the case's own intent and team; confirm the case instead.");
    expect(await reviewOf(unchanged)).toBeUndefined();
  });

  it("re-asks for an intent outside the list, and Enter cancels back to the action prompt", async () => {
    await makeCase("msg-013");
    const { out } = await drive(ME, ["r", "9", "", "x", "q"]);
    expect(out).toContain("Pick a number from the list.");
    expect(out).toContain("Unknown action. Type c, r, s, u or q.");
  });

  it("skips a case for this session only", async () => {
    const first = await makeCase("msg-013");
    const second = await makeCase("msg-014");
    const { out } = await drive(ME, ["s", "q"]);
    expect(out).toContain(`Case 2 of 2  ${second}`);
    expect(out).toContain("0 confirmed, 0 corrected, 1 skipped");
    expect(await nextCase(db)).toBe(first);
  });

  it("unmasks with a reason, logs it and prints the raw text", async () => {
    const caseId = await makeCase("msg-001");
    const { out } = await drive(ME, ["u", "x", "search the CRM by e-mail", "q"]);
    expect(out).toContain("A reason of 3-500 characters is required.");
    expect(out).toContain("Raw message (unmasked by reviewer-1; logged):");
    expect(out).toContain(record("msg-001").text.split("\n")[0]!.trim());
    const log = await db.selectFrom("unmask_log").selectAll().where("case_id", "=", caseId).execute();
    expect(log).toMatchObject([{ reviewer: "reviewer-1", reason: "search the CRM by e-mail" }]);
  });

  it("prints no identifier value unless unmasked", async () => {
    await makeCase("msg-001");
    await makeCase("msg-022");
    const { out } = await drive(ME, ["s", "s"]);
    for (const m of ["msg-001", "msg-022"]) {
      for (const i of labelsOf(m).fields.identifiers) expect(out, m).not.toContain(i.value);
    }
  });

  it("moves on when another reviewer got there first", async () => {
    const caseId = await makeCase("msg-013");
    const { out } = await drive(ME, [
      async () => {
        await confirmCase(db, caseId, { reviewer: "reviewer-2" });
        return "c";
      },
      "",
    ]);
    expect(out).toMatch(/Already reviewed by reviewer-2 at .+; moving on\./);
    expect(await reviewOf(caseId)).toMatchObject({ reviewer: "reviewer-2" });
  });

  it("selects cases with --spot-check, --team and --reason", async () => {
    const auto = await makeCase("msg-011"); // auto-routed
    await makeCase("msg-013"); // retention, cancellation
    const ambiguous = await makeCase("msg-022"); // billing, customer_ambiguous
    expect((await drive([...ME, "--spot-check"], ["c", ""])).out).toContain(`Case 1 of 1  ${auto}`);
    expect(await reviewOf(auto)).toMatchObject({ spot_check: true });
    expect((await drive([...ME, "--team", "billing"], ["q"])).out).toContain(`Case 1 of 1  ${ambiguous}`);
    expect((await drive([...ME, "--reason", "customer_ambiguous"], ["q"])).out).toContain(`Case 1 of 1  ${ambiguous}`);
  });

  it("handles usage errors, an empty queue and end of input", async () => {
    expect((await drive([], [])).code).toBe(2);
    expect((await drive([], [])).out).toContain("A reviewer handle is required");
    expect((await drive(["--reviewer", "Jan Novák"], [])).code).toBe(2);
    expect((await drive([...ME, "--team", "legal"], [])).code).toBe(2);
    expect((await drive([...ME, "--reason", "vibes"], [])).code).toBe(2);
    expect((await drive([], [], { REVIEWER: "reviewer-3" })).out).toContain("Reviewing as reviewer-3");

    expect((await drive(ME, [])).out).toContain("No cases to review.");
    await makeCase("msg-013");
    const eof = await drive(ME, []);
    expect(eof.code).toBe(0);
    expect(eof.out).toContain("Session: 0 confirmed, 0 corrected, 0 skipped, 0 unmasked.");
  });
});
