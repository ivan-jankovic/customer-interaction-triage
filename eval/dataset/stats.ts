// Step 6: label and review statistics for the finalized dataset.
// Prints markdown tables and rewrites the block between the stats markers in
// eval/data/README.md. Output is deterministic (no timestamps), so running it twice
// leaves the README unchanged.
//
// Usage: npm run dataset:stats

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CHANNELS, INTENTS, LANGUAGES, URGENCY } from "../../src/taxonomy.js";
import { readJsonl } from "../lib/jsonl.js";
import { PATHS } from "../lib/paths.js";
import type { RunReport } from "../lib/run-guard.js";
import type { DatasetRecord } from "../schema/dataset-record.schema.js";
import { COMPARED_FIELDS, fromGrader, fromLabels } from "./mismatch.js";

const START = "<!-- stats:start -->";
const END = "<!-- stats:end -->";

function table(header: string[], rows: (string | number)[][]): string {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

const pct = (n: number, d: number): string => (d === 0 ? "–" : `${Math.round((100 * n) / d)}%`);

function countBy<T>(items: readonly T[], key: (t: T) => string, keys: readonly string[]): (string | number)[][] {
  return keys.map((k) => [k, items.filter((i) => key(i) === k).length]);
}

export function statsMarkdown(dataset: readonly DatasetRecord[], injection: readonly DatasetRecord[], runs: readonly RunReport[]): string {
  const final = (r: DatasetRecord) => r.final!;
  const out: string[] = [];

  out.push("## Label statistics", "", `${dataset.length} dataset messages and ${injection.length} injection messages. Counts use the final labels.`, "");
  out.push("### Intent × language", "");
  out.push(
    table(
      ["intent", ...LANGUAGES, "total"],
      [
        ...INTENTS.map((intent) => [
          intent,
          ...LANGUAGES.map((l) => dataset.filter((r) => r.language === l && final(r).intent === intent).length),
          dataset.filter((r) => final(r).intent === intent).length,
        ]),
        ["**total**", ...LANGUAGES.map((l) => dataset.filter((r) => r.language === l).length), dataset.length],
      ],
    ),
    "",
  );
  out.push("### Channel, urgency and must-review", "");
  out.push(table(["channel", "messages"], countBy(dataset, (r) => r.channel, CHANNELS)), "");
  out.push(table(["urgency", "messages"], countBy(dataset, (r) => final(r).urgency, URGENCY)), "");
  out.push(
    table(
      ["must_review", "messages"],
      [
        ["true", dataset.filter((r) => final(r).must_review).length],
        ["  of which unclear", dataset.filter((r) => final(r).review_reasons.includes("unclear")).length],
        ["false", dataset.filter((r) => !final(r).must_review).length],
      ],
    ),
    "",
  );
  out.push(
    table(
      ["design", "messages"],
      [
        ["designed ambiguous", dataset.filter((r) => r.plan.designed_ambiguous).length],
        ["mixed Czech/Slovak", dataset.filter((r) => r.plan.mixed_language).length],
        ["with identifiers", dataset.filter((r) => final(r).fields.identifiers.length > 0).length],
      ],
    ),
    "",
  );

  out.push("## Review statistics", "");
  const needed = dataset.filter((r) => r.review.needed);
  const sampled = dataset.filter((r) => r.review.sampled);
  const reviewed = dataset.filter((r) => r.review.reviewed);
  const changed = reviewed.filter((r) => r.review.changed_fields.length > 0);
  const rewritten = [...dataset, ...injection].filter((r) => r.plan.attempt > 1);
  out.push(
    table(
      ["", "dataset", "injection"],
      [
        ["needed review (disagreement or invalid grader)", needed.length, injection.length],
        ["random agreement sample", sampled.length, "–"],
        ["reviewed by a person", reviewed.length, injection.filter((r) => r.review.reviewed).length],
        ["labels changed by the reviewer", changed.length, injection.filter((r) => r.review.changed_fields.length > 0).length],
        ["  of which in the agreement sample", changed.filter((r) => r.review.sampled).length, "–"],
        ["messages rewritten", rewritten.filter((r) => r.id.startsWith("msg-")).length, rewritten.filter((r) => r.id.startsWith("inj-")).length],
      ],
    ),
    "",
  );
  const fieldChanges = ["intent", "urgency", "must_review", "review_reasons", "service_type", "area"].map((f) => [
    f,
    reviewed.filter((r) => r.review.changed_fields.includes(f)).length,
  ]);
  out.push("Labels changed by the reviewer, per field:", "", table(["field", "messages"], fieldChanges), "");

  out.push("### Agreement with the final labels", "", "Share of dataset messages where each label source matches the final labels.", "");
  const sources: [string, (r: DatasetRecord) => ReturnType<typeof fromLabels> | null][] = [
    ["chosen (generator)", (r) => fromLabels(r.chosen)],
    ...[0, 1].map((i): [string, (r: DatasetRecord) => ReturnType<typeof fromLabels> | null] => [
      `grader ${i === 0 ? "A" : "B"} (${dataset[0]?.graders[i]?.model ?? "?"})`,
      (r) => (r.graders[i]?.output ? fromGrader(r.graders[i]!.output!) : null),
    ]),
  ];
  out.push(
    table(
      ["source", ...COMPARED_FIELDS, "all five", "invalid"],
      sources.map(([name, get]) => {
        const pairs = dataset.map((r) => ({ s: get(r), f: fromLabels(final(r)) }));
        const valid = pairs.filter((p) => p.s !== null);
        return [
          name,
          ...COMPARED_FIELDS.map((field) => pct(valid.filter((p) => p.s![field] === p.f[field]).length, dataset.length)),
          pct(valid.filter((p) => COMPARED_FIELDS.every((field) => p.s![field] === p.f[field])).length, dataset.length),
          dataset.length - valid.length,
        ];
      }),
    ),
    "",
  );

  out.push("## Runs", "", "Paid model runs used to build the dataset (from `.work/runs.jsonl`).", "");
  out.push(
    table(
      ["script", "date", "jobs", "calls by model", "input / cached / output tokens", "cost (USD)", "note"],
      runs.map((r) => [
        r.script,
        r.started.slice(0, 10),
        `${r.jobsDone}/${r.jobsPlanned}`,
        Object.entries(r.totals).map(([m, t]) => `${m} ×${t.calls}`).join(", "),
        Object.values(r.totals)
          .map((t) => `${t.input_tokens + t.cache_creation_input_tokens} / ${t.cache_read_input_tokens} / ${t.output_tokens}`)
          .join("; "),
        r.spentUsd.toFixed(2),
        r.note ?? "",
      ]),
    ),
    "",
    `**Total cost: $${runs.reduce((s, r) => s + r.spentUsd, 0).toFixed(2)}.**`,
  );
  return out.join("\n");
}

export function replaceStatsBlock(readme: string, markdown: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) throw new Error(`README is missing the ${START} / ${END} markers`);
  return `${readme.slice(0, start + START.length)}\n${markdown}\n${readme.slice(end)}`;
}

function main(): void {
  const dataset = readJsonl<DatasetRecord>(PATHS.dataset);
  const injection = readJsonl<DatasetRecord>(PATHS.injection);
  if (dataset.length === 0) throw new Error("No finalized dataset. Run npm run dataset:finalize first.");
  const markdown = statsMarkdown(dataset, injection, readJsonl<RunReport>(PATHS.runLog));
  console.log(markdown);
  writeFileSync(PATHS.dataReadme, replaceStatsBlock(readFileSync(PATHS.dataReadme, "utf8"), markdown));
  console.log(`\nUpdated ${PATHS.dataReadme}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
