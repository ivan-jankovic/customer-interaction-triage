// The small evaluation subset (P04): 18 messages for cheap runs while developing, and for the
// CI evaluation from P12. The chosen IDs are stored in eval/data/subsets/small.json, so the
// subset stays the same even if this selection code changes.
//
// Usage: npm run dataset:subset   (rewrites small.json; only needed if the dataset changes)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHANNELS, INTENTS, LANGUAGES } from "../src/taxonomy.js";
import { readJsonl } from "./lib/jsonl.js";
import { PATHS } from "./lib/paths.js";
import { createRng } from "./lib/rng.js";
import type { DatasetRecord } from "./schema/dataset-record.schema.js";

export const SMALL_SUBSET_PATH = join(dirname(PATHS.dataset), "subsets", "small.json");
export const SMALL_SUBSET_SEED = 20261119;
export const PER_INTENT = 3;
export const MIN_AMBIGUOUS = 2;
export const SMALL_SUBSET_RULE =
  `${PER_INTENT} messages per intent; every language (cs, sk, en) and channel (email, chat, call) present; ` +
  `at least ${MIN_AMBIGUOUS} designed-ambiguous messages. Labels are the final labels.`;

export interface SubsetFile {
  seed: number;
  rule: string;
  ids: string[];
}

type Selectable = Pick<DatasetRecord, "id" | "channel" | "language" | "plan" | "final">;

export function meetsRule(records: readonly Selectable[]): boolean {
  const has = <T>(values: readonly T[], get: (r: Selectable) => T) =>
    values.every((v) => records.some((r) => get(r) === v));
  const perIntent = INTENTS.every((i) => records.filter((r) => r.final?.intent === i).length === PER_INTENT);
  return (
    perIntent &&
    has(LANGUAGES, (r) => r.language) &&
    has(CHANNELS, (r) => r.channel) &&
    records.filter((r) => r.plan.designed_ambiguous).length >= MIN_AMBIGUOUS
  );
}

/**
 * Draws 3 messages per intent with a seeded shuffle and keeps the first draw that meets the
 * rule (the seed advances by one per attempt), so the result depends only on the dataset and
 * the seed.
 */
export function selectSmallSubset(records: readonly Selectable[], seed = SMALL_SUBSET_SEED): string[] {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  for (let attempt = 0; attempt < 1000; attempt++) {
    const rng = createRng(seed + attempt);
    const picked = INTENTS.flatMap((intent) =>
      rng.shuffle(sorted.filter((r) => r.final?.intent === intent)).slice(0, PER_INTENT),
    );
    if (meetsRule(picked)) return picked.map((r) => r.id).sort();
  }
  throw new Error("No subset meeting the rule was found in 1000 attempts; check the dataset.");
}

export function readSmallSubset(path = SMALL_SUBSET_PATH): SubsetFile {
  return JSON.parse(readFileSync(path, "utf8")) as SubsetFile;
}

function main(): void {
  const ids = selectSmallSubset(readJsonl<DatasetRecord>(PATHS.dataset));
  const file: SubsetFile = { seed: SMALL_SUBSET_SEED, rule: SMALL_SUBSET_RULE, ids };
  mkdirSync(dirname(SMALL_SUBSET_PATH), { recursive: true });
  writeFileSync(SMALL_SUBSET_PATH, JSON.stringify(file, null, 2) + "\n");
  console.log(`Wrote ${ids.length} ids to ${SMALL_SUBSET_PATH}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
