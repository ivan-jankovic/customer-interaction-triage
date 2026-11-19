// The classify CLI against PostgreSQL with a mocked model client: no model calls.

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runClassify } from "../../src/cli/classify.js";
import type { LlmClient, LlmRequest, LlmResult, TokenCounter } from "../../src/llm/client.js";
import { runMask } from "../../src/cli/mask.js";
import { VALID_CLASSIFICATION } from "../support/attempts.js";

/** What the model returns under classify.v2: no identifiers (they come from the masking map). */
const { identifiers: _ids, ...V2_FIELDS } = VALID_CLASSIFICATION.fields;
const V2_OUTPUT = { ...VALID_CLASSIFICATION, fields: V2_FIELDS };
const RAW = "V Kolíně nejde internet. Číslo zákazníka MR12345678, tel. +420 777 123 456.";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

let testDb: TestDatabase;
let interactionId: string;

function mockLlm(text: string) {
  const calls: LlmRequest[] = [];
  const llm: LlmClient & TokenCounter = {
    complete(req): Promise<LlmResult> {
      calls.push(req);
      return Promise.resolve({
        ok: true,
        text,
        model: req.model,
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      });
    },
    countTokens: () => Promise.resolve(4321),
  };
  return { llm, calls };
}

async function run(argv: string[], text = JSON.stringify(V2_OUTPUT), env: NodeJS.ProcessEnv = {}) {
  const { llm, calls } = mockLlm(text);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runClassify(argv, {
    db: testDb.db,
    env,
    createLlm: () => llm,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), calls };
}

async function classificationCount(): Promise<number> {
  const r = await sql<{ n: string }>`select count(*) as n from classifications`.execute(testDb.db);
  return Number(r.rows[0]?.n);
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
  const row = await testDb.db
    .insertInto("interactions")
    .values({ external_id: "msg-901", channel: "chat", language: "cs", raw_text: RAW })
    .returning("id")
    .executeTakeFirstOrThrow();
  interactionId = row.id;
});

afterAll(async () => {
  await testDb?.drop();
});

describe("npm run classify", () => {
  it("classifies an interaction found by external_id and stores one valid row", async () => {
    const before = await classificationCount();
    const { code, out, calls } = await run(["msg-901"]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    // Only masked text reaches the model.
    expect(calls[0]?.user).toContain("V Kolíně nejde internet. Číslo zákazníka [CUSTOMER_NUMBER_1], tel. [PHONE_1].");
    expect(calls[0]?.user).not.toContain("MR12345678");
    expect(calls[0]?.user).not.toContain("777 123 456");
    expect(out).toContain("Masked with mask.v1 (now): 2 identifier(s).");
    expect(out).toContain("Outcome: valid");
    expect(out).toContain('"intent": "technical_fault"');
    // The stored classification's identifiers come from the masking map.
    const stored = await testDb.db
      .selectFrom("classifications")
      .select("fields")
      .where("outcome", "=", "valid")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(stored.fields?.identifiers).toEqual([
      { type: "customer_number", value: "MR12345678" },
      { type: "phone", value: "+420 777 123 456" },
    ]);
    expect(await classificationCount()).toBe(before + 1);
  });

  it("finds an interaction by its uuid and reuses the stored masking", async () => {
    const { code, out } = await run([interactionId]);
    expect(code).toBe(0);
    expect(out).toContain("Masked with mask.v1 (stored earlier): 2 identifier(s).");
    const rows = await sql<{
      n: string;
    }>`select count(*) as n from masked_identifiers where interaction_id = ${interactionId}`.execute(testDb.db);
    expect(Number(rows.rows[0]?.n)).toBe(2);
  });

  it("stores an invalid output as an invalid row and still exits 0", async () => {
    const before = await classificationCount();
    const { code, out } = await run(["msg-901"], '{"intent": "technical_fault"}');
    expect(code).toBe(0);
    expect(out).toContain("Outcome: invalid");
    expect(await classificationCount()).toBe(before + 1);
    const latest = await testDb.db
      .selectFrom("classifications")
      .select(["outcome", "raw_output"])
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(latest).toEqual({ outcome: "invalid", raw_output: '{"intent": "technical_fault"}' });
  });

  it("exits 2 for an unknown id and stores nothing", async () => {
    const before = await classificationCount();
    const { code, err, calls } = await run(["msg-999"]);
    expect(code).toBe(2);
    expect(err).toContain('No interaction with id or external_id "msg-999"');
    expect(calls).toHaveLength(0);
    expect(await classificationCount()).toBe(before);
  });

  it("--dry-run prints the prompt and the token count and stores nothing", async () => {
    const before = await classificationCount();
    const { code, out, calls } = await run(["msg-901", "--dry-run"], "", { ANTHROPIC_API_KEY: "test" });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(out).toContain("=== system (classify.v2) ===");
    expect(out).toContain("<customer_message>\nV Kolíně nejde internet. Číslo zákazníka [CUSTOMER_NUMBER_1]");
    expect(out).toContain("Input tokens (count_tokens, free): 4321");
    expect(await classificationCount()).toBe(before);
  });

  it("fails before any call when ANTHROPIC_API_KEY is missing", async () => {
    const err: string[] = [];
    const code = await runClassify(["msg-901"], { db: testDb.db, env: {}, err: (l) => err.push(l), out: () => {} });
    expect(code).toBe(2);
    expect(err.join()).toMatch(/Missing ANTHROPIC_API_KEY/);
  });

  it("--dry-run masks in memory and stores no masking", async () => {
    const row = await testDb.db
      .insertInto("interactions")
      .values({ external_id: "msg-902", channel: "email", raw_text: "Smlouva SML-2024-00001 prosím." })
      .returning("id")
      .executeTakeFirstOrThrow();
    const { code, out } = await run(["msg-902", "--dry-run"], "", { ANTHROPIC_API_KEY: "test" });
    expect(code).toBe(0);
    expect(out).toContain("Smlouva [CONTRACT_NUMBER_1] prosím.");
    const stored = await testDb.db
      .selectFrom("interactions")
      .select("masked_text")
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    expect(stored.masked_text).toBeNull();
  });
});

describe("npm run mask", () => {
  it("prints the raw text, the masked text and the placeholders", async () => {
    await testDb.db
      .insertInto("interactions")
      .values({ external_id: "msg-903", channel: "chat", raw_text: "IBAN CZ12 0042 1234 5678 9012 3456, díky." })
      .execute();
    const out: string[] = [];
    expect(await runMask(["msg-903"], { db: testDb.db, out: (l) => out.push(l) })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("=== raw ===\nIBAN CZ12 0042 1234 5678 9012 3456, díky.");
    expect(text).toContain("=== masked ===\nIBAN [IBAN_1], díky.");
    expect(text).toContain("| [IBAN_1] | iban | CZ12 0042 1234 5678 9012 3456 |");
    expect(text).toContain("Masked with mask.v1, now.");
  });

  it("exits 2 for an unknown interaction", async () => {
    const err: string[] = [];
    expect(await runMask(["msg-999"], { db: testDb.db, err: (l) => err.push(l) })).toBe(2);
    expect(err.join()).toContain('"msg-999"');
  });
});
