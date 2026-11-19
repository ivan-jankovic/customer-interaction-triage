// npm run eval:injection (P11) over the real injection set and seed, with a scripted client
// that plays classifier, agent and judge. No model calls.

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InjectionMetrics } from "../../eval/injection/metrics.js";
import { writeInjectionReports, type InjectionRunInfo } from "../../eval/injection/report.js";
import { runInjectionEval, type InjectionLlm } from "../../eval/injection/run.js";
import type { InjectionOutputLine } from "../../eval/injection/score.js";
import { readJsonl } from "../../eval/lib/jsonl.js";
import { PATHS } from "../../eval/lib/paths.js";
import type { DatasetRecord } from "../../eval/schema/dataset-record.schema.js";
import type { ConverseRequest, ConverseResult, LlmRequest } from "../../src/llm/client.js";
import { mask } from "../../src/pipeline/mask.js";
import { escapeMessage } from "../../src/pipeline/understand.js";

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const records = readJsonl<DatasetRecord>(PATHS.injection);
const starts = records.map((r) => [r.id, escapeMessage(mask(r.text).maskedText).slice(0, 80)] as const);
const idOf = (text: string) => starts.find(([, s]) => text.includes(s))![0];

/**
 * Classifies every message as labelled (or with `override` for some IDs), lets the agent check
 * outages and answer inconclusive, and grades every summary as faithful with no personal data.
 */
function scripted(override: Record<string, object> = {}) {
  const complete: LlmRequest[] = [];
  const converse: ConverseRequest[] = [];
  const llm: InjectionLlm = {
    complete(req) {
      complete.push(req);
      const isJudge = "faithful" in (req.schema as { properties: object }).properties;
      if (isJudge) {
        const text = JSON.stringify({ faithful: 5, complete: 4, contains_personal_data: false, reason: "ok" });
        return Promise.resolve({ ok: true, text, model: req.model, usage: USAGE });
      }
      const id = idOf(req.user);
      const r = records.find((x) => x.id === id)!;
      const l = r.final!;
      const text = JSON.stringify({
        intent: l.intent,
        urgency: l.urgency,
        language: r.language,
        fields: { service_type: l.fields.service_type, area: l.fields.area },
        summary: "Customer writes about their service.",
        confidence: 0.9,
        ...override[id],
      });
      return Promise.resolve({ ok: true, text, model: req.model, usage: USAGE });
    },
    converse(req): Promise<ConverseResult> {
      converse.push(req);
      if (req.messages.length === 1) {
        const area = /Area: (.+?) \(from/.exec(req.messages[0]!.content as string)?.[1] ?? "Praha";
        const use = { id: "tu_1", name: "check_outages", input: { area } };
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
      const text = JSON.stringify({
        likely_cause: "inconclusive",
        confidence: 0.5,
        summary: "No outage found; nothing else to check.",
        evidence: [{ tool: "check_outages", finding: "No ongoing outage in the area." }],
      });
      return Promise.resolve({
        ok: true,
        content: [{ type: "text", text }],
        toolUses: [],
        text,
        stopReason: "end_turn",
        model: req.model,
        usage: USAGE,
      });
    },
  };
  return { llm, complete, converse };
}

function setup(override: Record<string, object> = {}) {
  const resultsDir = mkdtempSync(join(tmpdir(), "eval-injection-"));
  const client = scripted(override);
  const log: string[] = [];
  let t = Date.parse("2026-11-20T10:00:00Z");
  const deps = {
    createLlm: () => client.llm,
    env: {},
    resultsDir,
    clock: () => new Date((t += 1000)),
    git: () => ({ commit: "f".repeat(40), dirty: false }),
    confirm: () => Promise.resolve(true),
    log: (l: string) => log.push(l),
  };
  return { resultsDir, client, log, deps };
}

const metricsOf = (dir: string) => JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8")) as InjectionMetrics;

describe("npm run eval:injection", () => {
  it("--dry-run plans every repeat, makes no call and writes nothing", async () => {
    const { resultsDir, client, log, deps } = setup();
    expect(await runInjectionEval(["--repeat", "2", "--dry-run"], deps)).toBeNull();
    expect(client.complete).toHaveLength(0);
    expect(client.converse).toHaveLength(0);
    expect(readdirSync(resultsDir)).toEqual([]);
    // Per repeat: 15 classifications, 15 judge calls, 3 agent turns for each of the 2 labelled faults.
    expect(log.join("\n")).toMatch(/30 jobs, 72 model calls/);
    expect(log.join("\n")).toMatch(/Cap: \$3\.00\./);
  });

  it("rejects a bad --repeat", async () => {
    await expect(runInjectionEval(["--repeat", "0", "--dry-run"], setup().deps)).rejects.toThrow(/--repeat/);
  });

  it("runs all 15 through the pipeline; safe outputs pass every scenario", async () => {
    const { client, deps, log } = setup();
    const dir = (await runInjectionEval(["--yes"], deps))!;
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as InjectionRunInfo;
    expect(run).toMatchObject({
      kind: "injection",
      repeats: 1,
      complete: true,
      classifier: { promptVersion: "classify.v2" },
      investigator: { promptVersion: "investigate.v1" },
      judge: { promptVersion: "summary-judge.v1" },
      routerVersion: "route.v4",
      masker: { version: "mask.v1" },
    });
    const lines = readJsonl<InjectionOutputLine>(join(dir, "outputs.jsonl"));
    expect(lines).toHaveLength(15);
    // The agent ran for the two technical faults only, and the judge for every valid summary.
    expect(lines.filter((l) => l.investigation).map((l) => l.id)).toEqual(["inj-008", "inj-014"]);
    expect(lines.every((l) => l.judge?.outcome === "graded")).toBe(true);

    const m = metricsOf(dir);
    expect(m.overall).toEqual({ scenarios: 15, passed: 15, rate: 1 });
    expect(m.intentAccuracy).toBe(1);
    expect(m.scenarios.find((s) => s.id === "inj-011")!.routes[0]).toMatchObject({
      team: "retention",
      review: true,
      reasonCodes: ["cancellation"],
    });
    // Seeded customers (crm-generate.v3): no CRM reason code on a found injection message.
    expect(m.reasonCodes.customer_not_found).toBe(0);
    expect(log.join("\n")).toContain("Scenarios passed: 15 / 15");

    // No model saw an identifier value from any message.
    const sent = JSON.stringify([client.complete, client.converse]);
    for (const r of records) for (const i of mask(r.text).identifiers) expect(sent).not.toContain(i.value);

    const md = readFileSync(join(dir, "report.md"), "utf8");
    expect(md).toContain("| Scenarios passed | 15 / 15 (100.0%) |");
    expect(md).toContain("None: every scenario passed in every repeat.");
  });

  it("fails the scenario whose output is unsafe, and says why", async () => {
    const { deps } = setup({ "inj-011": { intent: "billing_question" } });
    const m = metricsOf((await runInjectionEval(["--yes"], deps))!);
    expect(m.overall.passed).toBe(14);
    const s = m.scenarios.find((x) => x.id === "inj-011")!;
    expect(s.status).toBe("fail");
    expect(s.failedChecks.map((f) => f.name)).toEqual(["review_held", "goal"]);
  });

  it("--repeat 2 stores two outputs per message, and the report recomputes byte for byte", async () => {
    const { deps } = setup();
    const dir = (await runInjectionEval(["--repeat", "2", "--yes"], deps))!;
    const lines = readJsonl<InjectionOutputLine>(join(dir, "outputs.jsonl"));
    expect(lines).toHaveLength(30);
    expect(lines.filter((l) => l.id === "inj-001").map((l) => l.repeat)).toEqual([1, 2]);
    const before = ["metrics.json", "report.md", "report.html"].map((f) => readFileSync(join(dir, f), "utf8"));
    await writeInjectionReports(dir, { injectionPath: PATHS.injection, log: () => {} });
    const after = ["metrics.json", "report.md", "report.html"].map((f) => readFileSync(join(dir, f), "utf8"));
    expect(after).toEqual(before);
  });
});
