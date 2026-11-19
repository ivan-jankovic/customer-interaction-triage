// The investigation evaluation (P10): metrics from hand-made outputs, and the runner over the
// real dataset, seed and kept classify.v2 run with a rule-based scripted agent. No model calls.

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeInvestigationMetrics,
  type CauseLabel,
  type InvestigationOutputLine,
} from "../../eval/investigate/metrics.js";
import { writeInvestigationReports, type InvestigationRunInfo } from "../../eval/investigate/report.js";
import { DEFAULT_INPUT_RUN, runInvestigateEval } from "../../eval/investigate/run.js";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { ConverseClient, ConverseRequest, ConverseResult, UserContent } from "../../src/llm/client.js";
import { investigationAttempt, failedInvestigation, inconclusiveInvestigation } from "../support/attempts.js";

const USAGE = { input_tokens: 3000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const KEPT_INPUT = join(PATHS.results, "kept", DEFAULT_INPUT_RUN);

describe("computeInvestigationMetrics", () => {
  const labels = new Map<string, CauseLabel>([
    ["a", { language: "cs", expected: "area_outage" }],
    ["b", { language: "cs", expected: "area_outage" }],
    ["c", { language: "sk", expected: "line_fault" }],
    ["d", { language: "en", expected: "inconclusive" }],
    ["e", { language: "en", expected: "service_inactive" }],
  ]);
  const lines: InvestigationOutputLine[] = [
    { id: "a", notInvestigated: null, attempt: investigationAttempt() }, // right
    { id: "b", notInvestigated: null, attempt: inconclusiveInvestigation() }, // wrong: inconclusive
    { id: "c", notInvestigated: null, attempt: investigationAttempt({ likelyCause: "line_fault", confidence: 0.6 }) }, // right, low confidence
    { id: "d", notInvestigated: null, attempt: failedInvestigation() }, // no answer
    { id: "e", notInvestigated: "classified as complaint", attempt: null }, // miss
  ];
  const m = computeInvestigationMetrics(lines, labels);

  it("scores cause accuracy over every labelled fault, a not-investigated one as a miss", () => {
    expect(m).toMatchObject({ n: 5, investigated: 4, notInvestigated: ["e"], accuracy: 0.4 });
    expect(m.byLanguage).toEqual({
      cs: { n: 2, accuracy: 0.5 },
      sk: { n: 1, accuracy: 1 },
      en: { n: 2, accuracy: 0 },
    });
  });

  it("gives per-cause precision and recall, and the confusion matrix", () => {
    expect(m.byCause.area_outage).toEqual({ support: 2, predicted: 1, precision: 1, recall: 0.5 });
    expect(m.byCause.inconclusive).toEqual({ support: 1, predicted: 1, precision: 0, recall: 0 });
    expect(m.byCause.customer_equipment).toEqual({ support: 0, predicted: 0, precision: null, recall: null });
    expect(m.confusion.area_outage).toMatchObject({ area_outage: 1, inconclusive: 1 });
    expect(m.confusion.inconclusive["no answer"]).toBe(1);
    expect(m.confusion.service_inactive["not investigated"]).toBe(1);
  });

  it("counts outcomes, reviews, turns, tool calls, cost and latency over investigated faults", () => {
    expect(m.outcomes).toEqual({ valid: 3, step_limit: 0, invalid: 0, error: 1 });
    // b (inconclusive), c (0.6 < 0.7) and d (error) would go to review; a wouldn't.
    expect(m.reviewRate).toBe(0.75);
    expect(m.turns).toEqual({ mean: 1.75, max: 2, stepLimitHits: 0 });
    expect(m.toolCalls).toMatchObject({ mean: 0.75, max: 1, errors: 0 });
    expect(m.toolCalls.byTool).toEqual({ check_outages: 3, get_line_status: 0, get_recent_tickets: 0 });
    expect(m.cost.totalUsd).toBeCloseTo(0.0184 * 4, 6);
    expect(m.messages.map((x) => [x.id, x.predicted, x.correct, x.toReview])).toEqual([
      ["a", "area_outage", true, false],
      ["b", "inconclusive", false, true],
      ["c", "line_fault", true, true],
      ["d", "no answer", false, true],
      ["e", "not investigated", false, false],
    ]);
  });
});

/**
 * A rule-based agent: checks outages of the case's service type in its area (if any), then answers area_outage when
 * one was ongoing, else inconclusive. On the dataset it should get the 8 area_outage and the 7
 * inconclusive faults right, and miss line_fault (msg-071) and service_inactive (msg-069).
 */
function ruleAgent(): ConverseClient & { calls: ConverseRequest[] } {
  const calls: ConverseRequest[] = [];
  const answer = (body: object): ConverseResult => {
    const text = JSON.stringify(body);
    return {
      ok: true,
      content: [{ type: "text", text }],
      toolUses: [],
      text,
      stopReason: "end_turn",
      model: "claude-opus-5-5",
      usage: USAGE,
    };
  };
  return {
    calls,
    converse(req) {
      calls.push(req);
      const nothing = { likely_cause: "inconclusive", confidence: 0.5, summary: "Nothing found.", evidence: [] };
      if (req.messages.length === 1) {
        const first = req.messages[0]!.content as string;
        const area = /Area: (.+?) \(from/.exec(first)?.[1];
        const type = /Service type \(from the classification\): (\w+)/.exec(first)?.[1];
        if (!area) return Promise.resolve(answer(nothing));
        const input = type && type !== "unknown" ? { area, service_type: type } : { area };
        const use = { id: "tu_1", name: "check_outages", input };
        return Promise.resolve({
          ok: true,
          content: [{ type: "tool_use", ...use }],
          toolUses: [use],
          text: "",
          stopReason: "tool_use",
          model: req.model,
          usage: USAGE,
        });
      }
      const result = (req.messages.at(-1)!.content as UserContent[])[0] as { content: string };
      const outages = (
        JSON.parse(result.content) as { outages: { service_type: string; ongoing_when_message_received: boolean }[] }
      ).outages;
      const ongoing = outages.some((o) => o.ongoing_when_message_received);
      return Promise.resolve(
        answer(
          ongoing
            ? {
                likely_cause: "area_outage",
                confidence: 0.9,
                summary: "An outage covers the area.",
                evidence: [{ tool: "check_outages", finding: "Ongoing outage." }],
              }
            : { ...nothing, evidence: [{ tool: "check_outages", finding: "No ongoing outage." }] },
        ),
      );
    },
  };
}

function setup() {
  const resultsDir = mkdtempSync(join(tmpdir(), "eval-investigate-"));
  const agent = ruleAgent();
  const log: string[] = [];
  let t = Date.parse("2026-11-19T10:00:00Z");
  const deps = {
    createLlm: () => agent,
    env: {},
    resultsDir,
    clock: () => new Date((t += 1000)),
    git: () => ({ commit: "e".repeat(40), dirty: false }),
    confirm: () => Promise.resolve(true),
    log: (l: string) => log.push(l),
  };
  return { resultsDir, agent, log, deps };
}

describe("npm run eval:investigate", () => {
  it("--dry-run plans the 17 faults, makes no call and writes nothing", async () => {
    const { resultsDir, agent, log, deps } = setup();
    expect(await runInvestigateEval(["--from", KEPT_INPUT, "--dry-run"], deps)).toBeNull();
    expect(agent.calls).toHaveLength(0);
    expect(readdirSync(resultsDir)).toEqual([]);
    expect(log.join("\n")).toMatch(/17 jobs, 51 model calls/);
    expect(log.join("\n")).toMatch(/Cap: \$2\.00\./);
  });

  it("investigates every labelled fault from the kept classifications and scores it against the seed", async () => {
    const { agent, deps } = setup();
    const dir = (await runInvestigateEval(["--from", KEPT_INPUT, "--yes"], deps))!;
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as InvestigationRunInfo;
    expect(run).toMatchObject({
      kind: "investigate",
      set: "full",
      complete: true,
      investigator: {
        model: "claude-opus-5-5",
        promptVersion: "investigate.v1",
        investigatorVersion: "investigate.v1",
        maxTurns: 6,
      },
      input: { runId: DEFAULT_INPUT_RUN, classifierPromptVersion: "classify.v2" },
      masker: { version: "mask.v1" },
    });
    expect(run.ids).toHaveLength(17);
    const lines = readJsonl<InvestigationOutputLine>(join(dir, "outputs.jsonl"));
    expect(lines.map((l) => l.id)).toEqual(run.ids);
    expect(lines.every((l) => l.notInvestigated === null && l.attempt?.outcome === "valid")).toBe(true);

    const metrics = JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8")) as ReturnType<
      typeof computeInvestigationMetrics
    >;
    expect(metrics.accuracy).toBeCloseTo(15 / 17, 6);
    expect(metrics.messages.filter((x) => !x.correct).map((x) => [x.id, x.expected, x.predicted])).toEqual([
      ["msg-069", "service_inactive", "inconclusive"],
      ["msg-071", "line_fault", "inconclusive"],
    ]);
    // The agent saw masked text only.
    expect(JSON.stringify(agent.calls)).not.toMatch(/MR\d{8}|SML-\d{4}-\d{5}/);
    const md = readFileSync(join(dir, "report.md"), "utf8");
    expect(md).toContain("| Cause accuracy | 88.2% |");
    expect(md).toContain("indicative only");
  });

  it("recomputes the same report bytes from the stored outputs", async () => {
    const { deps } = setup();
    const dir = (await runInvestigateEval(["--from", KEPT_INPUT, "--yes"], deps))!;
    const files = ["metrics.json", "report.md", "report.html"];
    const before = files.map((f) => readFileSync(join(dir, f), "utf8"));
    writeInvestigationReports(dir, { datasetPath: PATHS.dataset, log: () => {} });
    expect(files.map((f) => readFileSync(join(dir, f), "utf8"))).toEqual(before);
    expect(before[2]).toMatch(/^<!doctype html>/);
  });

  it("runs the small subset's technical faults only", async () => {
    const { deps } = setup();
    const dir = (await runInvestigateEval(["--from", KEPT_INPUT, "--subset", "small", "--yes"], deps))!;
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as InvestigationRunInfo;
    expect(run.set).toBe("small");
    expect(run.ids).toEqual(["msg-018", "msg-036", "msg-079"]);
  });

  it("stops at the cost cap and marks the run incomplete", async () => {
    const { deps } = setup();
    const dir = (await runInvestigateEval(
      ["--from", KEPT_INPUT, "--yes", "--max-cost", "0.05", "--concurrency", "1"],
      deps,
    ))!;
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as InvestigationRunInfo;
    expect(run.complete).toBe(false);
    expect(run.guard?.stoppedByBudget).toBe(true);
    expect(readJsonl(join(dir, "outputs.jsonl")).length).toBeLessThan(17);
  });
});
