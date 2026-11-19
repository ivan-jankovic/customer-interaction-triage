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
        [
          "Routing",
          `${m.routing.enricherVersion}, ${m.routing.routerVersion}, CRM seed sha256 ${m.routing.seedSha256.slice(0, 12)}`,
        ],
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
        ["Routing accuracy (team)", pct(o.routing.accuracy)],
        [
          "Must-review recall / precision",
          `${pct(o.routing.mustReview.recall)} / ${pct(o.routing.mustReview.precision)}`,
        ],
        ["Sent to review", pct(o.routing.reviewRate)],
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
        ["Routing", ...LANGUAGES.map((l) => pct(m.byLanguage[l].routing.accuracy))],
        [
          "Must-review R / P",
          ...LANGUAGES.map(
            (l) =>
              `${pct(m.byLanguage[l].routing.mustReview.recall)} / ${pct(m.byLanguage[l].routing.mustReview.precision)}`,
          ),
        ],
        ["Sent to review", ...LANGUAGES.map((l) => pct(m.byLanguage[l].routing.reviewRate))],
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

  push("## Routing");
  const mr = o.routing.mustReview;
  push(
    `Each message is masked, enriched against the mock CRM (${m.routing.enricherVersion}) with the classified area and service type, and routed (${m.routing.routerVersion}), as the pipeline would. No model is called. Invalid outputs and errors go to \`general\` and to review.`,
  );
  push(
    table(
      ["Must-review", "Value"],
      [
        ["Labelled must-review", mr.labelled],
        ["Sent to review", `${mr.reviewed} (${pct(o.routing.reviewRate)} of all messages)`],
        ["Caught (true positives)", mr.tp],
        ["Reviewed but not labelled (false positives)", mr.fp],
        ["Missed (false negatives)", mr.fn],
        ["Recall / precision", `${pct(mr.recall)} / ${pct(mr.precision)}`],
      ],
    ),
  );
  push("### Reason codes");
  push("Messages each code fired on; a message can have several.");
  push(
    table(
      ["Code", "Messages"],
      m.routing.reasonCodes.map((r) => [`\`${r.code}\``, r.n]),
    ),
  );
  push("### Labelled reasons");
  push(
    "Whether each labelled review reason got its own code. A message caught by another code still counts for must-review recall.",
  );
  push(
    table(
      ["Labelled reason", "Caught by", "Labelled", "Caught", "Rate"],
      m.routing.labelledReasons.map((r) => [`\`${r.reason}\``, `\`${r.caughtBy}\``, r.labelled, r.caught, pct(r.rate)]),
    ),
  );
  push("### Missed must-review messages");
  if (m.routing.missed.length === 0) push("None: every message labelled must-review was sent to review.");
  else
    push(
      table(
        ["Message", "Lang", "Label", "Labelled reasons", "Routed to", "Confidence"],
        m.routing.missed.map((x) => [
          x.id,
          x.language,
          `\`${x.label}\``,
          x.labelReasons.map((r) => `\`${r}\``).join(", "),
          `\`${x.predictedTeam}\``,
          num(x.confidence),
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
