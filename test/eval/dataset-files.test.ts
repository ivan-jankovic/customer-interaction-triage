// Checks over the committed dataset files (eval/data/dataset.jsonl and injection.jsonl).
// These run on the real data, not fixtures: they are the merge checks from the P00
// validation.md for "Dataset files", "Review complete" and "Synthetic data and safety".

import { describe, expect, it } from "vitest";
import { CHANNELS, IDENTIFIER_TYPES, INTENTS, LANGUAGES } from "../../src/taxonomy.js";
import { INJECTION_TACTICS, type DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import { recordErrors } from "../../eval/schema/validate.js";
import { findMismatch } from "../../eval/dataset/mismatch.js";
import {
  IDENTIFIER_PATTERNS,
  isValidBirthNumberChecksum,
  isValidCzAccountChecksum,
  isValidIban,
} from "../../eval/dataset/identifiers.js";
import { deniedNamesIn } from "../../eval/lib/denylist.js";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";

const dataset = readJsonl<DatasetRecord>(PATHS.dataset);
const injection = readJsonl<DatasetRecord>(PATHS.injection);
const all = [...dataset, ...injection];

const count = <T>(items: readonly T[], key: (t: T) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
};

describe("dataset files: schema and coverage", () => {
  it("every record passes the JSON Schema and the label rules", () => {
    const problems = all.flatMap((r) => recordErrors(r).map((e) => `${(r as { id?: string }).id}: ${e}`));
    expect(problems).toEqual([]);
    for (const r of all) expect(r.final, r.id).not.toBeNull();
  });

  it("ids are unique across both files, with msg-/inj- prefixes in the right file", () => {
    const ids = all.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of dataset) expect(r.id).toMatch(/^msg-/);
    for (const r of injection) expect(r.id).toMatch(/^inj-/);
  });

  it("dataset.jsonl has 100 records: 60 ±2 cs, 20 ±2 sk, 20 ±2 en", () => {
    expect(dataset).toHaveLength(100);
    const byLang = count(dataset, (r) => r.language);
    for (const [lang, target] of [["cs", 60], ["sk", 20], ["en", 20]] as const) {
      expect(Math.abs((byLang.get(lang) ?? 0) - target), lang).toBeLessThanOrEqual(2);
    }
  });

  it("every intent appears at least twice per language, every channel at least 20 times", () => {
    const byIntentLang = count(dataset, (r) => `${r.final!.intent}/${r.language}`);
    for (const intent of INTENTS) for (const lang of LANGUAGES) {
      expect(byIntentLang.get(`${intent}/${lang}`) ?? 0, `${intent}/${lang}`).toBeGreaterThanOrEqual(2);
    }
    const byChannel = count(dataset, (r) => r.channel);
    for (const ch of CHANNELS) expect(byChannel.get(ch) ?? 0, ch).toBeGreaterThanOrEqual(20);
  });

  it("every identifier type appears at least 5 times, and every identifier is verbatim in its text", () => {
    const ids = dataset.flatMap((r) => r.final!.fields.identifiers);
    const byType = count(ids, (i) => i.type);
    for (const t of IDENTIFIER_TYPES) expect(byType.get(t) ?? 0, t).toBeGreaterThanOrEqual(5);
    for (const r of all) for (const i of r.final!.fields.identifiers) {
      expect(r.text.includes(i.value), `${r.id}: ${i.type} ${i.value}`).toBe(true);
    }
  });

  it("injection.jsonl has 13–17 records covering every tactic and all three languages", () => {
    expect(injection.length).toBeGreaterThanOrEqual(13);
    expect(injection.length).toBeLessThanOrEqual(17);
    expect(new Set(injection.map((r) => r.attack!.tactic))).toEqual(new Set(INJECTION_TACTICS));
    expect(new Set(injection.map((r) => r.language))).toEqual(new Set(LANGUAGES));
  });
});

describe("dataset files: review complete", () => {
  // Recomputed from the stored labels, so the check does not rely on review.needed being right.
  const mismatched = dataset.filter((r) => findMismatch(r.chosen, r.graders.map((g) => (g.valid ? g.output : null))).needed);

  it("every message with a disagreement or an invalid grader output is reviewed", () => {
    expect(mismatched.length).toBeGreaterThan(0);
    for (const r of mismatched) {
      expect(r.review.needed, r.id).toBe(true);
      expect(r.review.reviewed, r.id).toBe(true);
    }
  });

  it("exactly 10 all-agree messages are sampled, and all of them are reviewed", () => {
    const sampled = dataset.filter((r) => r.review.sampled);
    expect(sampled).toHaveLength(10);
    const mismatchedIds = new Set(mismatched.map((r) => r.id));
    for (const r of sampled) {
      expect(mismatchedIds.has(r.id), r.id).toBe(false);
      expect(r.review.reviewed, r.id).toBe(true);
    }
  });

  it("every dataset message has both graders' answers; injection messages have none", () => {
    for (const r of dataset) expect(r.graders, r.id).toHaveLength(2);
    for (const r of injection) expect(r.graders, r.id).toEqual([]);
  });

  it("every injection record is reviewed", () => {
    for (const r of injection) expect(r.review.reviewed, r.id).toBe(true);
  });

  it("no record is still flagged for rewrite, and unreviewed records keep their chosen labels", () => {
    for (const r of all) {
      expect(r.review.outcome, r.id).not.toBe("rewrite_requested");
      if (!r.review.reviewed) expect(r.final, r.id).toEqual(r.chosen);
    }
  });
});

describe("dataset files: synthetic data", () => {
  it("no message names a real Czech or Slovak operator", () => {
    const hits = all.flatMap((r) => deniedNamesIn(r.text).map((n) => `${r.id}: ${n}`));
    expect(hits).toEqual([]);
  });

  it("every e-mail address in any text uses a reserved domain", () => {
    const reserved = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|[a-z0-9-]+\.example)$/i;
    const addresses = all.flatMap((r) => (r.text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map((a) => ({ id: r.id, a })));
    expect(addresses.length).toBeGreaterThan(0);
    const bad = addresses.filter(({ a }) => !reserved.test(a.replace(/[.,;:]+$/, "")));
    expect(bad).toEqual([]);
  });

  it("labelled identifiers match the fictional formats, with invalid checksums where stated", () => {
    for (const r of all) for (const i of r.final!.fields.identifiers) {
      const where = `${r.id}: ${i.type} ${i.value}`;
      expect(i.value, where).toMatch(IDENTIFIER_PATTERNS[i.type]);
      if (i.type === "birth_number") expect(isValidBirthNumberChecksum(i.value), where).toBe(false);
      if (i.type === "bank_account") expect(isValidCzAccountChecksum(i.value.split("/")[0]!), where).toBe(false);
      if (i.type === "iban") expect(isValidIban(i.value), where).toBe(false);
    }
  });
});
