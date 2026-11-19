// report.html for one evaluation run (P04): the same content as report.md, as one
// self-contained page. Inline CSS and SVG only (no scripts, fonts or other external
// resources), readable in light and dark mode and at phone width. Colours follow the
// dataviz reference palette: categorical blue/orange for the two-series bars, the blue
// sequential ramp for the confusion matrix (its own dark-mode steps), text in text tokens.
// Every chart has a table beside or below it, so nothing depends on colour alone.

import { LANGUAGES } from "../../src/taxonomy.js";
import type { Metrics } from "../metrics/aggregate.js";
import type { RunInfo } from "../run.js";
import { int, ms, num, pct, usd } from "./format.js";
import { WORST_ERRORS_SHOWN } from "./markdown.js";

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const TOKENS_LIGHT = `
  color-scheme: light;
  --surface-1: #fcfcfb; --surface-2: #f3f2ef; --border: #e2e1dc;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #6f6e69;
  --series-1: #2a78d6; --series-2: #eb6834; --grid: #e2e1dc;
  --seq-0: #f0efec; --seq-1: #cde2fb; --seq-2: #86b6ef; --seq-3: #3987e5; --seq-4: #1c5cab; --seq-5: #0d366b;
  --on-seq-dark: #ffffff;`;
const TOKENS_DARK = `
  color-scheme: dark;
  --surface-1: #1a1a19; --surface-2: #232321; --border: #383835;
  --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #a3a29a;
  --series-1: #3987e5; --series-2: #d95926; --grid: #383835;
  --seq-0: #262624; --seq-1: #104281; --seq-2: #1c5cab; --seq-3: #2a78d6; --seq-4: #5598e7; --seq-5: #9ec5f4;
  --on-seq-dark: #0b0b0b;`;

const CSS = `
:root {${TOKENS_LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${TOKENS_DARK} } }
:root[data-theme="dark"] {${TOKENS_DARK} }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface-1); color: var(--text-primary);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; overflow-wrap: anywhere; }
h2 { font-size: 18px; margin: 36px 0 12px; }
p, li { color: var(--text-secondary); }
.muted { color: var(--text-muted); font-size: 13px; }
.settings { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 12px 0; font-size: 14px; }
.settings dt { color: var(--text-muted); } .settings dd { margin: 0; overflow-wrap: anywhere; }
.warn { color: var(--text-primary); background: var(--surface-2); border-left: 3px solid var(--series-2); padding: 8px 12px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.tile { background: var(--surface-2); border-radius: 8px; padding: 12px 14px; }
.tile .label { color: var(--text-muted); font-size: 13px; }
.tile .value { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile .sub { color: var(--text-secondary); font-size: 12px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--text-muted); font-weight: 500; }
td.n, th.n { text-align: right; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
svg { display: block; width: 100%; height: auto; }
svg text { fill: var(--text-secondary); font: 12px system-ui, sans-serif; }
.legend { display: flex; gap: 16px; font-size: 13px; color: var(--text-secondary); margin: 4px 0 8px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: baseline; }
`;

function tableHtml(header: string[], rows: string[][], numeric: number[] = []): string {
  const cls = (i: number) => (numeric.includes(i) ? ' class="n"' : "");
  return `<div class="scroll"><table><thead><tr>${header.map((h, i) => `<th${cls(i)}>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

/** Precision and recall per intent: grouped horizontal bars, 0–100%. */
function intentBars(m: Metrics): string {
  const rowH = 34;
  const left = 140;
  const width = 640;
  const plotW = width - left - 50;
  const height = m.perIntent.length * rowH + 28;
  const x = (v: number) => left + v * plotW;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (t) =>
        `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${height - 22}" stroke="var(--grid)" stroke-width="1"/>` +
        `<text x="${x(t)}" y="${height - 6}" text-anchor="middle">${t * 100}%</text>`,
    )
    .join("");
  const bars = m.perIntent
    .map((i, k) => {
      const y = k * rowH + 6;
      const bar = (v: number | null, dy: number, color: string, label: string) =>
        v === null
          ? `<text x="${left + 4}" y="${y + dy + 9}" font-size="11">no ${label.toLowerCase()}</text>`
          : `<rect x="${left}" y="${y + dy}" width="${Math.max(0, v * plotW)}" height="11" rx="2" fill="var(${color})"><title>${i.intent}: ${label} ${pct(v)}</title></rect>`;
      return (
        `<text x="${left - 8}" y="${y + 16}" text-anchor="end">${i.intent}</text>` +
        bar(i.precision, 0, "--series-1", "Precision") +
        bar(i.recall, 13, "--series-2", "Recall")
      );
    })
    .join("");
  return (
    `<div class="legend"><span><span class="swatch" style="background:var(--series-1)"></span>Precision</span>` +
    `<span><span class="swatch" style="background:var(--series-2)"></span>Recall</span></div>` +
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Precision and recall per intent">${grid}${bars}</svg>`
  );
}

/** Confusion matrix as a heatmap; colour = share of the row, so rows of different sizes compare. */
function confusionHeatmap(m: Metrics): string {
  const cell = 64;
  const left = 140;
  const top = 96;
  const cols = m.confusion.columns;
  const width = left + cols.length * cell + 8;
  const height = top + m.confusion.rows.length * cell + 8;
  const head = cols
    .map(
      (c, j) =>
        `<text transform="translate(${left + j * cell + cell / 2},${top - 8}) rotate(-40)" text-anchor="start">${c}</text>`,
    )
    .join("");
  const rows = m.confusion.rows
    .map((r, i) => {
      const counts = m.confusion.counts[i]!;
      const total = counts.reduce((a, b) => a + b, 0);
      const cells = counts
        .map((c, j) => {
          const share = total === 0 ? 0 : c / total;
          const step = c === 0 ? 0 : Math.min(5, 1 + Math.floor(share * 5));
          const textColor = step >= 3 ? "var(--on-seq-dark)" : "var(--text-primary)";
          const x = left + j * cell;
          const y = top + i * cell;
          return (
            `<rect x="${x + 1}" y="${y + 1}" width="${cell - 2}" height="${cell - 2}" rx="4" fill="var(--seq-${step})">` +
            `<title>label ${r}, predicted ${cols[j]}: ${c} of ${total}</title></rect>` +
            `<text x="${x + cell / 2}" y="${y + cell / 2 + 5}" text-anchor="middle" style="fill:${textColor};font-size:14px${r === cols[j] ? ";font-weight:700" : ""}">${c}</text>`
          );
        })
        .join("");
      return `<text x="${left - 8}" y="${top + i * cell + cell / 2 + 4}" text-anchor="end">${r}</text>${cells}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Confusion matrix, rows labelled intents, columns predicted">${head}${rows}</svg>`;
}

/** Intent accuracy per confidence band: one series, so no legend; n under each bar. */
function confidenceBars(m: Metrics): string {
  const width = 480;
  const height = 200;
  const plotTop = 10;
  const plotH = 140;
  const bandW = (width - 40) / m.confidence.bands.length;
  const y = (v: number) => plotTop + plotH - v * plotH;
  const grid = [0, 0.5, 1]
    .map(
      (t) =>
        `<line x1="36" x2="${width}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/><text x="30" y="${y(t) + 4}" text-anchor="end">${t * 100}%</text>`,
    )
    .join("");
  const bars = m.confidence.bands
    .map((b, k) => {
      const cx = 40 + k * bandW + bandW / 2;
      const bar =
        b.intentAccuracy === null
          ? ""
          : `<path d="M${cx - 18},${y(0)} V${y(b.intentAccuracy) + 4} q0,-4 4,-4 h28 q4,0 4,4 V${y(0)} Z" fill="var(--series-1)"><title>confidence ${b.band}: ${pct(b.intentAccuracy)} of ${b.n}</title></path>` +
            `<text x="${cx}" y="${y(b.intentAccuracy) - 6}" text-anchor="middle">${pct(b.intentAccuracy, 0)}</text>`;
      return `${bar}<text x="${cx}" y="${plotTop + plotH + 18}" text-anchor="middle">${b.band}</text><text x="${cx}" y="${plotTop + plotH + 34}" text-anchor="middle" style="font-size:11px;fill:var(--text-muted)">n=${b.n}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Intent accuracy by confidence band">${grid}${bars}</svg>`;
}

export function renderHtml(run: RunInfo, m: Metrics): string {
  const o = m.overall;
  const tile = (label: string, value: string, sub = "") =>
    `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  const settings: [string, string][] = [
    ["Set", `${run.set} (${run.ids.length} messages)`],
    ["Classifier", `${run.classifier.model}, effort ${run.classifier.effort}, ${run.classifier.promptVersion}`],
    ["Summary judge", `${run.judge.model}, effort ${run.judge.effort}, ${run.judge.promptVersion}`],
    ["Dataset", `${run.dataset.file} (${run.dataset.sha256.slice(0, 12)})`],
    ["Code", `${run.git.commit.slice(0, 12)}${run.git.dirty ? " (uncommitted changes)" : ""}`],
    ["Started", run.startedAt],
  ];
  const lang = (l: (typeof LANGUAGES)[number]) => m.byLanguage[l];

  const body = [
    `<h1>Evaluation ${esc(run.runId)}</h1>`,
    `<dl class="settings">${settings.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`,
    run.complete ? "" : `<p class="warn">Incomplete run: ${m.n} of ${run.ids.length} messages finished.</p>`,
    `<p class="muted">Scoring is deterministic (<code>npm run eval:report -- ${esc(run.runId)}</code> recomputes this page); a new run calls the model again and may differ slightly. Invalid outputs and errors count as wrong.</p>`,
    `<div class="tiles">`,
    tile("Intent accuracy", pct(o.intentAccuracy), `n=${m.n}`),
    tile("Intent macro F1", num(m.macroF1, 3)),
    tile("Valid outputs", pct(o.validRate), `invalid: ${m.outcomes.invalid}, errors: ${m.outcomes.error}`),
    tile("Summary faithful", num(m.summaries.faithfulMean), `complete ${num(m.summaries.completeMean)} (1–5)`),
    tile("Cost", usd(m.cost.totalUsd, 2), `${usd(m.cost.perMessageUsd)} per message`),
    tile("Latency p50", ms(m.latencyMs.p50), `p95 ${ms(m.latencyMs.p95)}`),
    `</div>`,

    `<h2>Overall and by language</h2>`,
    tableHtml(
      ["Metric", "All", ...LANGUAGES.map((l) => `${l} (n=${lang(l).n})${lang(l).indicative ? "*" : ""}`)],
      [
        ["Valid outputs", pct(o.validRate), ...LANGUAGES.map((l) => pct(lang(l).validRate))],
        ["Intent", pct(o.intentAccuracy), ...LANGUAGES.map((l) => pct(lang(l).intentAccuracy))],
        ["Urgency", pct(o.urgencyAccuracy), ...LANGUAGES.map((l) => pct(lang(l).urgencyAccuracy))],
        ["Language", pct(o.languageAccuracy), ...LANGUAGES.map((l) => pct(lang(l).languageAccuracy))],
        ["Service type", pct(o.serviceTypeAccuracy), ...LANGUAGES.map((l) => pct(lang(l).serviceTypeAccuracy))],
        ["Area", pct(o.areaAccuracy), ...LANGUAGES.map((l) => pct(lang(l).areaAccuracy))],
        [
          "Identifiers precision",
          pct(o.identifiers.precision),
          ...LANGUAGES.map((l) => pct(lang(l).identifiers.precision)),
        ],
        ["Identifiers recall", pct(o.identifiers.recall), ...LANGUAGES.map((l) => pct(lang(l).identifiers.recall))],
        [
          "Identifier lists exact",
          pct(o.identifiers.exactListRate),
          ...LANGUAGES.map((l) => pct(lang(l).identifiers.exactListRate)),
        ],
        [
          "Summary faithful",
          num(m.summaries.faithfulMean),
          ...LANGUAGES.map((l) => num(m.summaries.byLanguage[l].faithfulMean)),
        ],
        [
          "Summary complete",
          num(m.summaries.completeMean),
          ...LANGUAGES.map((l) => num(m.summaries.byLanguage[l].completeMean)),
        ],
      ],
      [1, 2, 3, 4],
    ),
    `<p class="muted">* Under 30 messages: indicative only. Summaries with personal data: ${pct(m.summaries.personalDataShare)} of ${m.summaries.graded} graded (${m.summaries.notGraded} not graded).</p>`,

    `<h2>Intents</h2>`,
    intentBars(m),
    tableHtml(
      ["Intent", "Labelled", "Predicted", "Correct", "Precision", "Recall", "F1"],
      m.perIntent.map((i) => [
        `<code>${i.intent}</code>`,
        String(i.support),
        String(i.predicted),
        String(i.correct),
        pct(i.precision),
        pct(i.recall),
        num(i.f1, 3),
      ]),
      [1, 2, 3, 4, 5, 6],
    ),

    `<h2>Confusion matrix</h2>`,
    `<p class="muted">Rows: labelled intent. Columns: predicted intent; <code>invalid</code> collects invalid outputs and errors. Shade = share of the row; the diagonal (bold) is correct.</p>`,
    `<div class="scroll">${confusionHeatmap(m)}</div>`,

    `<h2>Confidence</h2>`,
    `<p>Mean confidence ${num(m.confidence.meanCorrect)} when the intent was right, ${num(m.confidence.meanWrong)} when it was wrong.</p>`,
    confidenceBars(m),

    `<h2>Worst errors</h2>`,
    m.worstErrors.length === 0
      ? `<p>No wrong intents among the valid outputs.</p>`
      : tableHtml(
          ["Message", "Lang", "Label", "Predicted", "Confidence", "Summary"],
          m.worstErrors
            .slice(0, WORST_ERRORS_SHOWN)
            .map((e) => [
              e.id,
              e.language,
              `<code>${e.label}</code>`,
              `<code>${e.predicted}</code>`,
              num(e.confidence),
              esc(e.summary),
            ]),
          [4],
        ),

    `<h2>Cost and latency</h2>`,
    tableHtml(
      ["", "Classifier", "Judge", "Total"],
      [
        ["Cost", usd(m.cost.classifierUsd), usd(m.cost.judgeUsd), usd(m.cost.totalUsd)],
        ["Input tokens", int(m.cost.classifierTokens.input_tokens), int(m.cost.judgeTokens.input_tokens), ""],
        [
          "Cache reads",
          int(m.cost.classifierTokens.cache_read_input_tokens),
          int(m.cost.judgeTokens.cache_read_input_tokens),
          "",
        ],
        [
          "Cache writes",
          int(m.cost.classifierTokens.cache_creation_input_tokens),
          int(m.cost.judgeTokens.cache_creation_input_tokens),
          "",
        ],
        ["Output tokens", int(m.cost.classifierTokens.output_tokens), int(m.cost.judgeTokens.output_tokens), ""],
      ],
      [1, 2, 3],
    ),
    `<p class="muted">Classifier latency: p50 ${ms(m.latencyMs.p50)}, p95 ${ms(m.latencyMs.p95)}, max ${ms(m.latencyMs.max)}.${
      m.cost.unpricedCalls ? ` Calls without a known price, not in the totals: ${m.cost.unpricedCalls}.` : ""
    }</p>`,
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evaluation report</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
