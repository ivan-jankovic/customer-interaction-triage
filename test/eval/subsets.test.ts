import { describe, expect, it } from "vitest";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { meetsRule, readSmallSubset, selectSmallSubset, SMALL_SUBSET_SEED } from "../../eval/subsets.js";
import { CHANNELS, INTENTS, LANGUAGES } from "../../src/taxonomy.js";

const dataset = readJsonl<DatasetRecord>(PATHS.dataset);
const byId = new Map(dataset.map((r) => [r.id, r]));
const subset = readSmallSubset();
const records = subset.ids.map((id) => byId.get(id)!);

describe("small subset", () => {
  it("has 18 unique ids that exist in the dataset", () => {
    expect(subset.ids).toHaveLength(18);
    expect(new Set(subset.ids).size).toBe(18);
    expect(subset.ids.every((id) => byId.has(id))).toBe(true);
  });

  it("meets the rule: 3 per intent, every language and channel, at least 2 designed-ambiguous", () => {
    for (const intent of INTENTS) expect(records.filter((r) => r.final!.intent === intent)).toHaveLength(3);
    for (const language of LANGUAGES) expect(records.some((r) => r.language === language)).toBe(true);
    for (const channel of CHANNELS) expect(records.some((r) => r.channel === channel)).toBe(true);
    expect(records.filter((r) => r.plan.designed_ambiguous).length).toBeGreaterThanOrEqual(2);
    expect(meetsRule(records)).toBe(true);
  });

  it("is what the selection gives for the stored seed", () => {
    expect(subset.seed).toBe(SMALL_SUBSET_SEED);
    expect(selectSmallSubset(dataset, subset.seed)).toEqual(subset.ids);
  });
});
