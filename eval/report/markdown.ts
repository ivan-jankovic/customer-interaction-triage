// report.md for one evaluation run (P04). Depends only on run.json and the metrics, so
// re-rendering gives the same bytes.

import { LANGUAGES } from "../../src/taxonomy.js";
import type { Metrics } from "../metrics/aggregate.js";
import type { RunInfo } from "../run.js";
import { int, ms, num, pct, usd } from "./format.js";

export const WORST_ERRORS_SHOWN = 10;

const table = (header: string[], rows: (string | number)[][]) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

export function renderMarkdown(run: RunInfo, m: Metrics): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines, "");

  push(`# Evaluation ${run.runId}`);
  push(
    table(
      ["Setting", "Value"],
      [
        ["Set", `${run.set} (${run.ids.length} messages${run.subset ? `, ${run.subset.file}` : ""})`],
        [
          "Classifier",
          `${run.classifier.model}, effort ${run.classifier.effort}, prompt ${run.classifier.promptVersion}`,
        ],
        ["Summary judge", `${run.judge.model}, effort ${run.judge.effort}, prompt ${run.judge.promptVersion}`],
        ["Masking", run.masker ? run.masker.version : "none (raw text sent to the model)"],
        ["Dataset", `${run.dataset.file} (sha256 ${run.dataset.sha256.slice(0, 12)})`],
        ["Code", `${run.git.commit.slice(0, 12)}${run.git.dirty ? " (with uncommitted changes)" : ""}`],
        ["Started", run.startedAt],
        ["Complete", run.complete ? "yes" : `**no**: ${m.n} of ${run.ids.length} messages finished`],
      ],
    ),
  );
  push(
    "The scoring is deterministic: `npm run eval:report -- " +
      run.runId +
      "` recomputes this report from the stored outputs. A new `npm run eval` calls the model again, and its numbers may differ slightly.",
  );

  push("## Overall");
  const o = m.overall;
  push(
    table(
      ["Metric", "Value"],
      [
        ["Messages", m.n],
        [
          "Valid outputs",
          `${pct(o.validRate)} (invalid: ${m.outcomes.invalid}, errors: ${m.outcomes.error}, fallbacks: ${m.outcomes.fellBack})`,
        ],
        ["Intent accuracy", pct(o.intentAccuracy)],
        ["Intent macro F1", num(m.macroF1, 3)],
        ["Urgency accuracy", pct(o.urgencyAccuracy)],
        ["Language accuracy", pct(o.languageAccuracy)],
        ["Service type accuracy", pct(o.serviceTypeAccuracy)],
        ["Area accuracy", pct(o.areaAccuracy)],
        ["Identifiers precision / recall", `${pct(o.identifiers.precision)} / ${pct(o.identifiers.recall)}`],
        ["Identifier lists exactly right", pct(o.identifiers.exactListRate)],
        ["Summary faithful / complete (1–5)", `${num(m.summaries.faithfulMean)} / ${num(m.summaries.completeMean)}`],
        ["Summaries with personal data", pct(m.summaries.personalDataShare)],
      ],
    ),
  );
  push("Invalid outputs and errors count as wrong in every accuracy.");

  push("## By language");
  push(
    table(
      [
        "Metric",
        ...LANGUAGES.map((l) => `${l} (n=${m.byLanguage[l].n}${m.byLanguage[l].indicative ? ", indicative" : ""})`),
      ],
      [
        ["Valid outputs", ...LANGUAGES.map((l) => pct(m.byLanguage[l].validRate))],
        ["Intent", ...LANGUAGES.map((l) => pct(m.byLanguage[l].intentAccuracy))],
        ["Urgency", ...LANGUAGES.map((l) => pct(m.byLanguage[l].urgencyAccuracy))],
        ["Language", ...LANGUAGES.map((l) => pct(m.byLanguage[l].languageAccuracy))],
        ["Service type", ...LANGUAGES.map((l) => pct(m.byLanguage[l].serviceTypeAccuracy))],
        ["Area", ...LANGUAGES.map((l) => pct(m.byLanguage[l].areaAccuracy))],
        [
          "Identifiers P / R",
          ...LANGUAGES.map(
            (l) => `${pct(m.byLanguage[l].identifiers.precision)} / ${pct(m.byLanguage[l].identifiers.recall)}`,
          ),
        ],
        [
          "Summary faithful / complete",
          ...LANGUAGES.map(
            (l) => `${num(m.summaries.byLanguage[l].faithfulMean)} / ${num(m.summaries.byLanguage[l].completeMean)}`,
          ),
        ],
      ],
    ),
  );
  push("Groups under 30 messages are indicative only: one message moves their accuracy by several points.");

  push("## Intents");
  push(
    table(
      ["Intent", "Labelled", "Predicted", "Correct", "Precision", "Recall", "F1"],
      m.perIntent.map((i) => [
        `\`${i.intent}\``,
        i.support,
        i.predicted,
        i.correct,
        pct(i.precision),
        pct(i.recall),
        num(i.f1, 3),
      ]),
    ),
  );
  push("### Confusion matrix");
  push("Rows are the labelled intents, columns the predicted ones; `invalid` collects invalid outputs and errors.");
  push(
    table(
      ["label \\ predicted", ...m.confusion.columns.map((c) => `\`${c}\``)],
      m.confusion.rows.map((r, i) => [
        `\`${r}\``,
        ...m.confusion.counts[i]!.map((c, j) => (r === m.confusion.columns[j] ? `**${c}**` : c)),
      ]),
    ),
  );

  push("## Confidence");
  push(
    `Mean confidence: ${num(m.confidence.meanCorrect)} when the intent was right, ${num(m.confidence.meanWrong)} when it was wrong.`,
  );
  push(
    table(
      ["Confidence", "Messages", "Intent accuracy"],
      m.confidence.bands.map((b) => [b.band, b.n, pct(b.intentAccuracy)]),
    ),
  );

  push("## Worst errors");
  if (m.worstErrors.length === 0) push("No wrong intents among the valid outputs.");
  else {
    push(
      `Wrong intents, most confident first (${Math.min(WORST_ERRORS_SHOWN, m.worstErrors.length)} of ${m.worstErrors.length}).`,
    );
    push(
      table(
        ["Message", "Lang", "Label", "Predicted", "Confidence", "Summary"],
        m.worstErrors
          .slice(0, WORST_ERRORS_SHOWN)
          .map((e) => [
            e.id,
            e.language,
            `\`${e.label}\``,
            `\`${e.predicted}\``,
            num(e.confidence),
            e.summary.replaceAll("|", "\\|"),
          ]),
      ),
    );
  }

  push("## Summaries");
  push(
    `Summaries graded by the judge: ${m.summaries.graded}. Valid outputs not graded (judge output invalid or failed): ${m.summaries.notGraded}.`,
  );

  push("## Cost and latency");
  const c = m.cost;
  push(
    table(
      ["", "Classifier", "Judge", "Total"],
      [
        ["Cost", usd(c.classifierUsd), usd(c.judgeUsd), usd(c.totalUsd)],
        ["Input tokens", int(c.classifierTokens.input_tokens), int(c.judgeTokens.input_tokens), ""],
        [
          "Cache reads",
          int(c.classifierTokens.cache_read_input_tokens),
          int(c.judgeTokens.cache_read_input_tokens),
          "",
        ],
        [
          "Cache writes",
          int(c.classifierTokens.cache_creation_input_tokens),
          int(c.judgeTokens.cache_creation_input_tokens),
          "",
        ],
        ["Output tokens", int(c.classifierTokens.output_tokens), int(c.judgeTokens.output_tokens), ""],
      ],
    ),
  );
  push(
    `Cost per message: ${usd(c.perMessageUsd)}.` +
      (c.unpricedCalls ? ` Calls served by a model without a known price, not in the totals: ${c.unpricedCalls}.` : ""),
  );
  push(`Classifier latency: p50 ${ms(m.latencyMs.p50)}, p95 ${ms(m.latencyMs.p95)}, max ${ms(m.latencyMs.max)}.`);

  return out.join("\n").trimEnd() + "\n";
}
