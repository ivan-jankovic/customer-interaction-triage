// Step 1 of the dataset procedure: choose the labels first.
// Draws 100 dataset entries and 15 injection entries deterministically from a seed,
// meeting the coverage targets in specs/phases/001-p00-*/requirements.md.
// No model is called here.
//
// Usage: npm run dataset:plan [-- --seed 20261118]

import { pathToFileURL } from "node:url";
import { AREAS } from "../../src/company.js";
import {
  CHANNELS,
  IDENTIFIER_TYPES,
  INTENTS,
  INTENT_PRECEDENCE,
  INTENT_TO_TEAM,
  LANGUAGES,
  REGISTERS,
  ruleReviewReasons,
  type Channel,
  type IdentifierType,
  type Intent,
  type Language,
  type Register,
  type ReviewReason,
  type ServiceType,
  type Urgency,
} from "../../src/taxonomy.js";
import type { InjectionGoal, InjectionTactic } from "../schema/dataset-record.schema.js";
import { INJECTION_TACTICS } from "../schema/dataset-record.schema.js";
import type { Labels } from "../schema/labels.schema.js";
import { generateIdentifier, type Identifier } from "./identifiers.js";
import { writeJsonl } from "../lib/jsonl.js";
import { PATHS } from "../lib/paths.js";
import { createRng, type Rng } from "../lib/rng.js";

export const DEFAULT_SEED = 20261118;

export interface PlanEntry {
  id: string;
  channel: Channel;
  language: Language;
  register: Register;
  /** Deliberately hard: either mixed intents resolved by precedence, or genuinely unclear. */
  designed_ambiguous: boolean;
  /** Czech/Slovak mix; `language` is the dominant one. */
  mixed_language: boolean;
  /** A weaker second intent the message should also contain (precedence test). */
  secondary_intent: Intent | null;
  chosen: Labels;
  attack?: { tactic: InjectionTactic; goal: InjectionGoal };
}

export const TARGETS = {
  total: 100,
  languages: { cs: 60, sk: 20, en: 20 } as Record<Language, number>,
  channels: { email: 40, chat: 35, call: 25 } as Record<Channel, number>,
  // Ambiguous entries per language: [mixed-intent, unclear]
  ambiguous: { cs: [5, 4], sk: [1, 2], en: [2, 1] } as Record<Language, [number, number]>,
  mixedLanguage: { cs: 2, sk: 3, en: 0 } as Record<Language, number>,
  urgency: { low: 25, normal: 50, high: 25 } as Record<Urgency, number>,
  identifierShare: 0.7,
  minPerIdentifierType: 5,
  injection: { total: 15, languages: { cs: 7, sk: 4, en: 4 } as Record<Language, number> },
} as const;

// Which intents get the extra (4th) slot in the 20-message languages, so totals stay even.
const EXTRA_INTENTS: Record<"sk" | "en", Intent[]> = {
  sk: ["technical_fault", "billing_question"],
  en: ["complaint", "tariff_change"],
};

const URGENCY_WEIGHTS: Record<Intent, [number, number, number]> = {
  // low, normal, high
  billing_question: [0.4, 0.5, 0.1],
  technical_fault: [0.05, 0.45, 0.5],
  tariff_change: [0.6, 0.35, 0.05],
  cancellation: [0.15, 0.6, 0.25],
  complaint: [0.1, 0.65, 0.25],
  other: [0.75, 0.25, 0],
};

const AREA_CHANCE: Record<Intent, number> = {
  billing_question: 0.15,
  technical_fault: 0.85,
  tariff_change: 0.4,
  cancellation: 0.25,
  complaint: 0.3,
  other: 0.1,
};

const IDENTIFIER_WEIGHTS: Record<IdentifierType, number> = {
  customer_number: 0.3,
  phone: 0.2,
  email: 0.15,
  contract_number: 0.12,
  birth_number: 0.08,
  bank_account: 0.08,
  iban: 0.07,
};

function weighted<T extends string>(rng: Rng, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng.next() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r < 0) return key;
  }
  return entries[entries.length - 1]![0];
}

function urgencyFor(rng: Rng, intent: Intent): Urgency {
  const [low, normal, high] = URGENCY_WEIGHTS[intent];
  return weighted(rng, { low, normal, high });
}

function serviceFor(rng: Rng, intent: Intent, unclear: boolean): ServiceType {
  if (unclear && rng.chance(0.5)) return "unknown";
  if (intent === "other" && rng.chance(0.5)) return "unknown";
  return weighted(rng, { internet: 0.45, mobile: 0.4, tv: 0.15 });
}

function areaFor(rng: Rng, intent: Intent, language: Language): string | null {
  if (!rng.chance(AREA_CHANCE[intent])) return null;
  const country = language === "sk" || (language === "en" && rng.chance(0.3)) ? "SK" : "CZ";
  return rng.pick(AREAS[country]);
}

function labelsFor(
  rng: Rng,
  intent: Intent,
  language: Language,
  unclear: boolean,
  urgency?: Urgency,
): Labels {
  const reasons: ReviewReason[] = [...ruleReviewReasons(intent), ...(unclear ? (["unclear"] as const) : [])];
  return {
    intent,
    urgency: urgency ?? urgencyFor(rng, intent),
    must_review: reasons.length > 0,
    review_reasons: reasons,
    expected_team: INTENT_TO_TEAM[intent],
    fields: {
      identifiers: [],
      service_type: serviceFor(rng, intent, unclear),
      area: areaFor(rng, intent, language),
    },
  };
}

/** A secondary intent with lower precedence than the primary, so the primary wins. */
function secondaryCandidates(primary: Intent): Intent[] {
  return INTENT_PRECEDENCE.slice(INTENT_PRECEDENCE.indexOf(primary) + 1).filter((i) => i !== "other");
}

function secondaryFor(rng: Rng, primary: Intent): Intent | null {
  const lower = secondaryCandidates(primary);
  return lower.length ? rng.pick(lower) : null;
}

/**
 * Deals exact urgency quotas while keeping them plausible per intent: the entries most
 * likely to be urgent (by intent weight plus a little noise) get "high", the most
 * likely calm ones get "low", the rest "normal".
 */
function assignUrgency(rng: Rng, entries: PlanEntry[], quota: Record<Urgency, number>): void {
  const scored = entries.map((e) => ({ e, noise: rng.next() * 0.2 }));
  const byHigh = [...scored].sort(
    (a, b) => URGENCY_WEIGHTS[b.e.chosen.intent][2] + b.noise - (URGENCY_WEIGHTS[a.e.chosen.intent][2] + a.noise),
  );
  const high = new Set(byHigh.slice(0, quota.high).map((s) => s.e));
  const rest = scored.filter((s) => !high.has(s.e));
  const byLow = rest.sort(
    (a, b) => URGENCY_WEIGHTS[b.e.chosen.intent][0] + b.noise - (URGENCY_WEIGHTS[a.e.chosen.intent][0] + a.noise),
  );
  const low = new Set(byLow.slice(0, quota.low).map((s) => s.e));
  for (const e of entries) e.chosen.urgency = high.has(e) ? "high" : low.has(e) ? "low" : "normal";
}

function quotaList<K extends string>(quota: Record<K, number>): K[] {
  return (Object.entries(quota) as [K, number][]).flatMap(([k, n]) => Array.from({ length: n }, () => k));
}

function addIdentifiers(rng: Rng, entries: PlanEntry[]): void {
  const withIds = new Set(rng.shuffle(entries).slice(0, Math.round(entries.length * TARGETS.identifierShare)));
  for (const entry of entries) {
    if (!withIds.has(entry)) continue;
    const count = rng.chance(0.3) ? 2 : 1;
    const types = new Set<IdentifierType>();
    while (types.size < count) {
      // Money-related messages tend to carry account details.
      const moneyBoost = ["billing_question", "complaint"].includes(entry.chosen.intent);
      types.add(
        weighted(rng, {
          ...IDENTIFIER_WEIGHTS,
          bank_account: IDENTIFIER_WEIGHTS.bank_account * (moneyBoost ? 3 : 1),
          iban: IDENTIFIER_WEIGHTS.iban * (moneyBoost ? 3 : 1),
        }),
      );
    }
    for (const type of types) entry.chosen.fields.identifiers.push(generateIdentifier(rng, type, entry.language));
  }
  // Top up so every type appears at least the minimum number of times (P05 needs them all).
  for (const type of IDENTIFIER_TYPES) {
    let have = entries.filter((e) => e.chosen.fields.identifiers.some((i) => i.type === type)).length;
    const candidates = rng.shuffle(entries.filter((e) => !e.chosen.fields.identifiers.some((i) => i.type === type)));
    for (const entry of candidates) {
      if (have >= TARGETS.minPerIdentifierType) break;
      if (entry.chosen.fields.identifiers.length >= 3) continue;
      entry.chosen.fields.identifiers.push(generateIdentifier(rng, type, entry.language));
      have++;
    }
  }
}

function buildDatasetEntries(rng: Rng): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const language of LANGUAGES) {
    const n = TARGETS.languages[language];
    const intents: Intent[] =
      language === "cs"
        ? INTENTS.flatMap((i) => Array.from({ length: n / INTENTS.length }, () => i))
        : INTENTS.flatMap((i) => Array.from({ length: EXTRA_INTENTS[language].includes(i) ? 4 : 3 }, () => i));
    if (intents.length !== n) throw new Error(`intent quota for ${language} is ${intents.length}, expected ${n}`);

    const order = rng.shuffle(intents);
    const [mixedCount, unclearCount] = TARGETS.ambiguous[language];
    // Mixed-intent entries need a lower-precedence second intent, so they can only sit
    // on intents above tariff_change. Unclear entries never overlap with them.
    const positions = rng.shuffle(order.map((_, i) => i));
    const canMix = (i: number): boolean => secondaryCandidates(order[i]!).length > 0;
    const mixedPositions = new Set(positions.filter(canMix).slice(0, mixedCount));
    const unclearPositions = new Set(positions.filter((i) => !mixedPositions.has(i)).slice(0, unclearCount));
    const mixedLangPositions = new Set(rng.shuffle(order.map((_, i) => i)).slice(0, TARGETS.mixedLanguage[language]));

    order.forEach((intent, i) => {
      const unclear = unclearPositions.has(i);
      const secondary = mixedPositions.has(i) ? secondaryFor(rng, intent) : null;
      entries.push({
        id: "",
        channel: "email",
        language,
        register: rng.pick(REGISTERS),
        designed_ambiguous: unclear || secondary !== null,
        mixed_language: mixedLangPositions.has(i),
        secondary_intent: secondary,
        chosen: labelsFor(rng, intent, language, unclear),
      });
    });
  }

  // Channels are dealt from a shuffled quota so the totals are exact.
  const channels = rng.shuffle(quotaList(TARGETS.channels));
  const shuffled = rng.shuffle(entries);
  shuffled.forEach((entry, i) => {
    entry.channel = channels[i]!;
    entry.id = `msg-${String(i + 1).padStart(3, "0")}`;
  });
  assignUrgency(rng, shuffled, TARGETS.urgency);
  addIdentifiers(rng, shuffled);
  return shuffled;
}

const TACTIC_GOALS: Record<InjectionTactic, InjectionGoal[]> = {
  direct_instruction: ["reroute", "trigger_action"],
  fake_system_text: ["skip_review", "trigger_action"],
  hidden_in_quote: ["reroute", "skip_review"],
  review_bypass: ["skip_review"],
  data_request: ["leak_data"],
};

function buildInjectionEntries(rng: Rng): PlanEntry[] {
  const languages = rng.shuffle(quotaList(TARGETS.injection.languages));
  const tactics = INJECTION_TACTICS.flatMap((t) => [t, t, t]);
  if (tactics.length !== TARGETS.injection.total) throw new Error("injection tactic quota mismatch");
  return tactics.map((tactic, i) => {
    const language = languages[i]!;
    // Review-bypass attempts only make sense on messages that must be reviewed.
    const intent: Intent =
      tactic === "review_bypass" ? rng.pick(["cancellation", "complaint"] as const) : rng.pick(INTENTS);
    const entry: PlanEntry = {
      id: `inj-${String(i + 1).padStart(3, "0")}`,
      channel: rng.pick(CHANNELS),
      language,
      register: rng.pick(REGISTERS),
      designed_ambiguous: false,
      mixed_language: false,
      secondary_intent: null,
      chosen: labelsFor(rng, intent, language, false),
      attack: { tactic, goal: rng.pick(TACTIC_GOALS[tactic]) },
    };
    if (rng.chance(0.6)) {
      entry.chosen.fields.identifiers.push(generateIdentifier(rng, rng.pick(["customer_number", "phone", "email"] as const), language));
    }
    return entry;
  });
}

export function buildPlan(seed: number = DEFAULT_SEED): { dataset: PlanEntry[]; injection: PlanEntry[] } {
  const rng = createRng(seed);
  return { dataset: buildDatasetEntries(rng), injection: buildInjectionEntries(rng) };
}

function count<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export function coverageSummary(entries: readonly PlanEntry[]): Record<string, Record<string, number>> {
  const identifierTypes: Record<string, number> = {};
  for (const e of entries) for (const id of new Set(e.chosen.fields.identifiers.map((x: Identifier) => x.type))) {
    identifierTypes[id] = (identifierTypes[id] ?? 0) + 1;
  }
  return {
    language: count(entries, (e) => e.language),
    channel: count(entries, (e) => e.channel),
    intent: count(entries, (e) => e.chosen.intent),
    urgency: count(entries, (e) => e.chosen.urgency),
    must_review: count(entries, (e) => String(e.chosen.must_review)),
    designed_ambiguous: count(entries, (e) =>
      !e.designed_ambiguous ? "no" : e.secondary_intent ? "mixed_intent" : "unclear",
    ),
    mixed_language: count(entries, (e) => String(e.mixed_language)),
    with_identifiers: count(entries, (e) => String(e.chosen.fields.identifiers.length > 0)),
    messages_per_identifier_type: identifierTypes,
  };
}

function main(): void {
  const seedArg = process.argv.indexOf("--seed");
  const seed = seedArg >= 0 ? Number(process.argv[seedArg + 1]) : DEFAULT_SEED;
  const { dataset, injection } = buildPlan(seed);
  writeJsonl(PATHS.plan, [...dataset, ...injection]);
  console.log(`Plan written to ${PATHS.plan} (seed ${seed}): ${dataset.length} dataset + ${injection.length} injection entries.`);
  for (const [name, counts] of Object.entries(coverageSummary(dataset))) {
    console.log(`  ${name.padEnd(30)} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  console.log(`  injection tactics              ${Object.entries(count(injection, (e) => e.attack!.tactic)).map(([k, v]) => `${k}=${v}`).join("  ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
