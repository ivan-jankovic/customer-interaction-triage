// Metrics of an injection evaluation (P11 requirements.md, "Evaluation"), computed only from
// the stored outputs, the injection set (labels, attack, language) and the CRM seed. Each line
// is routed again here with the pipeline's own functions (eval/lib/route-message.ts), so
// `npm run eval:report` rescoring a run with a newer router or seed needs no model.

import type { CrmSeed } from "../../src/db/crm-seed.js";
import { LANGUAGES, REASON_CODES, type Language } from "../../src/taxonomy.js";
import { makeMessageRouter } from "../lib/route-message.js";
import { INJECTION_GOALS, INJECTION_TACTICS, type DatasetRecord } from "../schema/dataset-record.schema.js";
import {
  CHECKS,
  scoreRepeat,
  scoreScenarios,
  seedLeakKeys,
  type CheckName,
  type InjectionOutputLine,
  type RepeatScore,
  type ScenarioScore,
} from "./score.js";

export interface PassStats {
  scenarios: number;
  passed: number;
  rate: number | null;
}

export interface ScenarioRow extends ScenarioScore {
  tactic: string;
  goal: string;
  language: Language;
  labelledIntent: string;
  labelledTeam: string;
  mustReview: boolean;
  /** Per repeat, in order: the routed team, review flag and reason codes. */
  routes: { repeat: number; intent: string | null; team: string; review: boolean; reasonCodes: string[] }[];
  toolsCalled: string[];
}

export interface InjectionMetrics {
  /** Scenarios (messages) and repeats scored. */
  n: number;
  repeats: number;
  overall: PassStats;
  flaky: number;
  byTactic: Record<string, PassStats>;
  byGoal: Record<string, PassStats>;
  byLanguage: Record<Language, PassStats>;
  /** Failed repeats per check. */
  checkFailures: Record<CheckName, number>;
  /** Over all repeats. */
  intentAccuracy: number | null;
  teamAccuracy: number | null;
  reviewRate: number | null;
  reasonCodes: Record<string, number>;
  outcomes: Record<string, number>;
  toolCalls: { total: number; errors: number; byTool: Record<string, number> };
  /** retried: repeats whose judge answered invalid once and was asked again. */
  judge: { graded: number; meanFaithful: number | null; personalData: number; retried: number };
  cost: { totalUsd: number; meanUsdPerRepeat: number | null };
  latency: { meanMs: number | null; maxMs: number };
  scenarios: ScenarioRow[];
  repeatScores: RepeatScore[];
}

const stats = (rows: readonly ScenarioScore[]): PassStats => {
  const passed = rows.filter((r) => r.status === "pass").length;
  return { scenarios: rows.length, passed, rate: rows.length ? passed / rows.length : null };
};
const ratio = (num: number, den: number) => (den ? num / den : null);

export async function computeInjectionMetrics(
  lines: readonly InjectionOutputLine[],
  records: readonly DatasetRecord[],
  seed: CrmSeed,
): Promise<InjectionMetrics> {
  const byId = new Map(records.map((r) => [r.id, r]));
  const router = makeMessageRouter(seed);
  const seedKeys = seedLeakKeys(seed);
  const sorted = [...lines].sort((a, b) => a.id.localeCompare(b.id) || a.repeat - b.repeat);

  const repeatScores: RepeatScore[] = [];
  const routes = new Map<string, ScenarioRow["routes"]>();
  const tools = new Map<string, Set<string>>();
  const reasonCodes: Record<string, number> = Object.fromEntries(REASON_CODES.map((c) => [c, 0]));
  const outcomes: Record<string, number> = { valid: 0, invalid: 0, error: 0 };
  const byTool: Record<string, number> = {};
  let intentRight = 0;
  let teamRight = 0;
  let reviewed = 0;
  let toolErrors = 0;
  let cost = 0;
  let latencySum = 0;
  let latencyMax = 0;
  const faithful: number[] = [];
  let personal = 0;
  let judgeRetries = 0;

  for (const line of sorted) {
    const record = byId.get(line.id);
    if (!record?.attack) throw new Error(`${line.id} is not in the injection set.`);
    const labels = record.final ?? record.chosen;
    const r = await router({ id: line.id, text: record.text }, line.attempt, line.investigation);
    const allowedCustomerIds = r.enrichment
      ? r.enrichment.customerId
        ? [r.enrichment.customerId]
        : r.enrichment.candidates.map((x) => x.customerId)
      : [];
    repeatScores.push(scoreRepeat(record, line, { ...r, allowedCustomerIds }, seedKeys));

    const c = line.attempt.outcome === "valid" ? line.attempt.classification : null;
    outcomes[line.attempt.outcome] = (outcomes[line.attempt.outcome] ?? 0) + 1;
    if (c?.intent === labels.intent) intentRight++;
    if (r.targetTeam === labels.expected_team) teamRight++;
    if (r.needsReview) reviewed++;
    for (const code of r.reasonCodes) reasonCodes[code] = (reasonCodes[code] ?? 0) + 1;
    routes.set(line.id, [
      ...(routes.get(line.id) ?? []),
      {
        repeat: line.repeat,
        intent: c?.intent ?? null,
        team: r.targetTeam,
        review: r.needsReview,
        reasonCodes: r.reasonCodes,
      },
    ]);
    const called = tools.get(line.id) ?? new Set<string>();
    for (const call of line.investigation?.toolCalls ?? []) {
      byTool[call.tool] = (byTool[call.tool] ?? 0) + 1;
      if (call.is_error) toolErrors++;
      called.add(call.tool);
    }
    tools.set(line.id, called);
    if (line.judge?.scores) {
      faithful.push(line.judge.scores.faithful);
      if (line.judge.scores.contains_personal_data) personal++;
    }
    if (line.judgeRetried) judgeRetries++;
    cost +=
      (line.attempt.costUsd ?? 0) +
      (line.investigation?.costUsd ?? 0) +
      (line.judge?.costUsd ?? 0) +
      (line.judgeRetried?.costUsd ?? 0);
    const latency =
      line.attempt.latencyMs +
      (line.investigation?.latencyMs ?? 0) +
      (line.judge?.latencyMs ?? 0) +
      (line.judgeRetried?.latencyMs ?? 0);
    latencySum += latency;
    latencyMax = Math.max(latencyMax, latency);
  }

  const scenarioScores = scoreScenarios(repeatScores);
  const scenarios: ScenarioRow[] = scenarioScores.map((s) => {
    const record = byId.get(s.id)!;
    const labels = record.final ?? record.chosen;
    return {
      ...s,
      tactic: record.attack!.tactic,
      goal: record.attack!.goal,
      language: record.language,
      labelledIntent: labels.intent,
      labelledTeam: labels.expected_team,
      mustReview: labels.must_review,
      routes: routes.get(s.id) ?? [],
      toolsCalled: [...(tools.get(s.id) ?? [])].sort(),
    };
  });
  const group = (key: (r: ScenarioRow) => string, values: readonly string[]) =>
    Object.fromEntries(values.map((v) => [v, stats(scenarios.filter((r) => key(r) === v))]));
  const n = sorted.length;

  return {
    n: scenarios.length,
    repeats: n,
    overall: stats(scenarios),
    flaky: scenarios.filter((s) => s.status === "flaky").length,
    byTactic: group((r) => r.tactic, INJECTION_TACTICS),
    byGoal: group((r) => r.goal, INJECTION_GOALS),
    byLanguage: group((r) => r.language, LANGUAGES) as Record<Language, PassStats>,
    checkFailures: Object.fromEntries(
      CHECKS.map((name) => [
        name,
        repeatScores.filter((r) => r.checks.some((x) => x.name === name && !x.passed)).length,
      ]),
    ) as Record<CheckName, number>,
    intentAccuracy: ratio(intentRight, n),
    teamAccuracy: ratio(teamRight, n),
    reviewRate: ratio(reviewed, n),
    reasonCodes,
    outcomes,
    toolCalls: { total: Object.values(byTool).reduce((a, b) => a + b, 0), errors: toolErrors, byTool },
    judge: {
      graded: faithful.length,
      meanFaithful: faithful.length ? faithful.reduce((a, b) => a + b, 0) / faithful.length : null,
      personalData: personal,
      retried: judgeRetries,
    },
    cost: { totalUsd: cost, meanUsdPerRepeat: ratio(cost, n) },
    latency: { meanMs: ratio(latencySum, n), maxMs: latencyMax },
    scenarios,
    repeatScores,
  };
}
