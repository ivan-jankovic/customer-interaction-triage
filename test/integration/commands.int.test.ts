// `npm run process` and `npm run queue:status` (P08) against PostgreSQL and the Compose Redis,
// with a scripted model client: no model calls.

import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess } from "../../src/cli/process.js";
import { runQueueStatus } from "../../src/cli/queue-status.js";
import { loadServiceConfig } from "../../src/config.js";
import { seedCrm } from "../../src/db/crm.js";
import type { Database } from "../../src/db/database.js";
import { createQueue, enqueue, SWEEP_GRACE_MS, type ProcessQueue } from "../../src/queue.js";
import { byMaskedText, labelsOf, scriptedLlm, seed, storeMessage, type Answer } from "../support/pipeline.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

let testDb: TestDatabase;
let db: Kysely<Database>;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  db = testDb.db;
  await seedCrm(db, seed);
});

afterAll(async () => {
  await testDb?.drop();
});

describe("npm run process", () => {
  const run = async (argv: string[], script: Answer[] = ["valid"], env: NodeJS.ProcessEnv = {}, withLlm = true) => {
    const llm = scriptedLlm(script, byMaskedText(["msg-011", "msg-055"]));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runProcess(argv, {
      db,
      env,
      ...(withLlm ? { createLlm: () => llm } : {}),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join("\n"), err: err.join("\n"), calls: llm.calls.length };
  };

  it("processes a fresh interaction and prints each step and the case", async () => {
    const id = await storeMessage(db, "msg-011");
    const r = await run([id]);
    expect(r.code).toBe(0);
    expect(r.calls).toBe(1);
    expect(r.out).toContain("Steps: mask ran, classify ran, enrich ran, investigate skipped, route ran");
    expect(r.out).toContain(`Team: ${labelsOf("msg-011").expected_team}`);
    expect(r.out).toMatch(/4\. route +\(route\.v2\) team /);

    const again = await run([id], ["valid"], {}, false);
    expect(again.code).toBe(0);
    expect(again.out).toContain("existing case");
    expect(again.out).not.toContain("Steps:");
  });

  it("ends with a case on a transient error (no retry), and prints no identifier value", async () => {
    const id = await storeMessage(db, "msg-055");
    const r = await run([id], [{ status: 529 }]);
    expect(r.out).toContain("- classification_error: the classification call failed");
    for (const i of labelsOf("msg-055").fields.identifiers) expect(r.out).not.toContain(i.value);
  });

  it("says when a failure case was written", async () => {
    const id = await storeMessage(db, "msg-011");
    const r = await run([id], ["throw"]);
    expect(r.out).toContain("Processing failed at classify (Error); failure case written.");
    expect(r.out).toContain("- processing_failed: failed at classify: Error");
  });

  it("needs ANTHROPIC_API_KEY unless the case exists, and rejects bad arguments", async () => {
    const id = await storeMessage(db, "msg-011");
    const r = await run([id], ["valid"], {}, false);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Missing ANTHROPIC_API_KEY");
    expect((await run([])).code).toBe(2);
    expect((await run(["msg-does-not-exist"])).code).toBe(2);
  });
});

describe("npm run queue:status", () => {
  let queue: ProcessQueue;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ queue, close } = createQueue(loadServiceConfig().redisUrl, {
      name: `test-status-${randomBytes(4).toString("hex")}`,
      forIntake: true,
    }));
    await queue.waitUntilReady();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await close();
  });

  it("prints job counts, interactions by status and the backlog", async () => {
    const waiting = await storeMessage(db, "msg-011");
    await enqueue(queue, waiting);
    const out: string[] = [];
    const now = new Date(Date.now() + SWEEP_GRACE_MS + 1_000);
    expect(await runQueueStatus({ db, queue, now, out: (l) => out.push(l) })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(`Queue "${queue.name}": waiting 1, active 0, delayed 0, failed 0, completed 0`);
    expect(text).toMatch(/Interactions: processed \d+, received \d+/);
    // Every interaction without a case in this file's database is older than the grace period at `now`.
    const m = /Backlog \(no case\): (\d+), oldest stored .+; (\d+) older than 60 s/.exec(text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1);
    expect(m![2]).toBe(m![1]);
  });
});
