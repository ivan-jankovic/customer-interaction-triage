// Masking every dataset and injection message (115, free, no model): no labelled identifier
// may survive, and the mapping must be exactly the labelled identifiers.

import { describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { mask } from "../../src/pipeline/mask.js";

const records = [...readJsonl<DatasetRecord>(PATHS.dataset), ...readJsonl<DatasetRecord>(PATHS.injection)];
const labelsOf = (r: DatasetRecord) => (r.final ?? r.chosen).fields.identifiers;
const pairs = (ids: readonly { type: string; value: string }[]) => ids.map((i) => `${i.type} ${i.value}`).sort();

describe("masking the dataset", () => {
  it("covers all 115 messages and 106 labelled identifiers", () => {
    expect(records).toHaveLength(115);
    expect(records.reduce((n, r) => n + labelsOf(r).length, 0)).toBe(106);
  });

  it.each(records.map((r) => [r.id, r] as const))("%s: no labelled identifier is left in the masked text", (_id, r) => {
    const { maskedText } = mask(r.text);
    for (const { value } of labelsOf(r)) expect(maskedText, `"${value}" survived`).not.toContain(value);
  });

  it.each(records.map((r) => [r.id, r] as const))("%s: the mapping is exactly the labelled identifiers", (_id, r) => {
    expect(pairs(mask(r.text).identifiers)).toEqual(pairs(labelsOf(r)));
  });

  it("no message already contains placeholder-shaped text", () => {
    const placeholder = /\[(PHONE|EMAIL|IBAN|CUSTOMER_NUMBER|CONTRACT_NUMBER|BIRTH_NUMBER|BANK_ACCOUNT)_\d+\]/;
    expect(records.filter((r) => placeholder.test(r.text)).map((r) => r.id)).toEqual([]);
  });
});
