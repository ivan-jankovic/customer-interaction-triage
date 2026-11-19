// The masking step against PostgreSQL: stored once, reused, safe when two calls race.

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maskInteraction } from "../../src/db/masking.js";
import { MASKER_VERSION } from "../../src/pipeline/mask.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const TEXT = "Dobrý den, MR12345678, volejte +420 777 123 456 nebo 777 123 456? Mail jana.k82@example.com.";
let testDb: TestDatabase;

async function newInteraction(text = TEXT): Promise<string> {
  const row = await testDb.db
    .insertInto("interactions")
    .values({ channel: "email", raw_text: text })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const count = async (id: string) =>
  Number(
    (
      await sql<{ n: string }>`select count(*) as n from masked_identifiers where interaction_id = ${id}`.execute(
        testDb.db,
      )
    ).rows[0]?.n,
  );

beforeAll(async () => {
  testDb = await createTestDatabase({ migrate: true });
});

afterAll(async () => {
  await testDb?.drop();
});

describe("maskInteraction", () => {
  it("stores the masked text, version, time and mapping on the first call", async () => {
    const id = await newInteraction();
    const result = await maskInteraction(testDb.db, id);
    expect(result.stored).toBe("now");
    expect(result.maskedText).toBe("Dobrý den, [CUSTOMER_NUMBER_1], volejte [PHONE_1] nebo [PHONE_2]? Mail [EMAIL_1].");
    expect(result.maskerVersion).toBe(MASKER_VERSION);
    expect(result.identifiers.map((i) => [i.placeholder, i.type, i.value])).toEqual([
      ["[CUSTOMER_NUMBER_1]", "customer_number", "MR12345678"],
      ["[PHONE_1]", "phone", "+420 777 123 456"],
      ["[PHONE_2]", "phone", "777 123 456"],
      ["[EMAIL_1]", "email", "jana.k82@example.com"],
    ]);
    const row = await testDb.db
      .selectFrom("interactions")
      .select(["raw_text", "masked_text", "masker_version", "masked_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.raw_text).toBe(TEXT); // the original is kept
    expect(row.masked_at).toBeInstanceOf(Date);
    expect(await count(id)).toBe(4);
  });

  it("returns the stored result on a second call without new rows", async () => {
    const id = await newInteraction();
    const first = await maskInteraction(testDb.db, id);
    const second = await maskInteraction(testDb.db, id);
    expect(second.stored).toBe("earlier");
    expect({ ...second, stored: "now" }).toEqual(first);
    expect(await count(id)).toBe(4);
  });

  it("stores one mapping when two calls race", async () => {
    const id = await newInteraction();
    const results = await Promise.all(Array.from({ length: 5 }, () => maskInteraction(testDb.db, id)));
    expect(results.filter((r) => r.stored === "now")).toHaveLength(1);
    expect(new Set(results.map((r) => r.maskedText)).size).toBe(1);
    expect(await count(id)).toBe(4);
  });

  it("stores a masking with no identifiers", async () => {
    const id = await newInteraction("Dobrý den, nejde internet.");
    const result = await maskInteraction(testDb.db, id);
    expect(result).toMatchObject({ maskedText: "Dobrý den, nejde internet.", identifiers: [], stored: "now" });
  });

  it("rejects a half-set masking and an unknown identifier type", async () => {
    const id = await newInteraction();
    await expect(sql`update interactions set masked_text = 'x' where id = ${id}`.execute(testDb.db)).rejects.toThrow(
      "interactions_masking_check",
    );
    await expect(
      sql`insert into masked_identifiers (interaction_id, placeholder, type, value, normalized_value, start_offset, end_offset)
          values (${id}, '[NAME_1]', 'name', 'Jana', 'JANA', 0, 4)`.execute(testDb.db),
    ).rejects.toThrow("masked_identifiers_type_check");
  });
});
