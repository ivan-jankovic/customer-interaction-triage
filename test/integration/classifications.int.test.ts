// The classification store against PostgreSQL.

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KyselyClassificationStore } from "../../src/db/classifications.js";
import { attempt, errorAttempt, invalidAttempt, VALID_CLASSIFICATION } from "../support/attempts.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

let testDb: TestDatabase;
let store: KyselyClassificationStore;

async function newInteraction(): Promise<string> {
  const row = await testDb.db
    .insertInto("interactions")
    .values({ channel: "email", raw_text: "test" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  store = new KyselyClassificationStore(testDb.db);
});

afterAll(async () => {
  await testDb?.drop();
});

describe("KyselyClassificationStore", () => {
  it("stores a valid attempt and reads it back unchanged", async () => {
    const id = await newInteraction();
    const stored = await store.record(id, attempt());
    expect(stored).toMatchObject({ ...attempt(), interactionId: id });
    expect(stored.classification).toEqual(VALID_CLASSIFICATION);
    expect(stored.costUsd).toBeCloseTo(0.008, 6);
    expect(await store.latestValid(id)).toEqual(stored);
  });

  it("stores invalid and error attempts with their raw output and errors", async () => {
    const id = await newInteraction();
    const invalid = await store.record(id, invalidAttempt({ errors: ["/confidence must be <= 1", "/summary bad"] }));
    const failed = await store.record(id, errorAttempt({ costUsd: null }));
    expect(invalid).toMatchObject({ outcome: "invalid", classification: null, rawOutput: "not json {" });
    expect(invalid.errors).toEqual(["/confidence must be <= 1", "/summary bad"]);
    expect(failed).toMatchObject({ outcome: "error", rawOutput: null, costUsd: null });
    expect(await store.latestValid(id)).toBeUndefined();
  });

  it("returns the newest valid attempt and ignores newer invalid ones", async () => {
    const id = await newInteraction();
    await store.record(id, attempt({ classification: { ...VALID_CLASSIFICATION, summary: "first" } }));
    const second = await store.record(id, attempt({ classification: { ...VALID_CLASSIFICATION, summary: "second" } }));
    await store.record(id, invalidAttempt());
    await store.record(id, errorAttempt());
    expect((await store.latestValid(id))?.id).toBe(second.id);
    expect((await store.listFor(id)).map((r) => r.outcome)).toEqual(["error", "invalid", "valid", "valid"]);
  });

  it("records a fallback and its serving model", async () => {
    const id = await newInteraction();
    const stored = await store.record(id, attempt({ servedModel: "claude-opus-4-8", fellBack: true, costUsd: null }));
    expect(stored).toMatchObject({ requestedModel: "claude-opus-5-5", servedModel: "claude-opus-4-8", fellBack: true });
  });

  it("never updates rows: a new attempt adds a row", async () => {
    const id = await newInteraction();
    await store.record(id, attempt());
    await store.record(id, attempt());
    const r = await sql<{ n: string }>`select count(*) as n from classifications where interaction_id = ${id}`.execute(
      testDb.db,
    );
    expect(Number(r.rows[0]?.n)).toBe(2);
  });
});
