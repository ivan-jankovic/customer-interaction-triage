// The review page's HTML (P13 requirements.md, "Pages and routes"): pure functions from data to a
// document, so the layout is unit-tested without a server. Everything goes through `html`, which
// escapes every value; no page has a script. Masked text only: the raw text appears only when the
// unmask route passes `rawText`. No identifier values: the case view and list rows hold none.

import { describeStep } from "../../format/decision-log.js";
import { INTENTS, REASON_CODES, TEAMS, type Intent, type ReasonCode, type Team } from "../../taxonomy.js";
import type { CaseView, StoredReview } from "../case-view.js";
import type { QueueRow } from "../queue.js";
import type { ReviewedFilters, ReviewedRow } from "../reviewed.js";
import { NOTE_MAX_LENGTH, REASON_MAX_LENGTH, REASON_MIN_LENGTH, REVIEW_DECISIONS } from "../rules.js";
import { html, type HtmlValue, type SafeHtml } from "./html.js";

/** The queue's filters, carried through every link, form and redirect of the session. */
export interface PageFilters {
  team?: Team | undefined;
  reason?: ReasonCode | undefined;
  spotCheck: boolean;
}

/** Who is looking: shown in the header; the CSRF token goes into every form. */
export interface Viewer {
  reviewer: string;
  csrf: string;
}

export type FormName = "confirm" | "correct" | "unmask";

/** A refused action: which form, why, and what was typed, so the form is shown again filled in. */
export interface FormError {
  form: FormName;
  message: string;
  values: Record<string, string>;
}

const iso = (d: Date) => d.toISOString();

export function filterParams(f: PageFilters, extra: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  if (f.team) p.set("team", f.team);
  if (f.reason) p.set("reason", f.reason);
  if (f.spotCheck) p.set("spot_check", "1");
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

const hiddenFilters = (f: PageFilters) =>
  html`${f.team ? html`<input type="hidden" name="team" value="${f.team}">` : null}${
    f.reason ? html`<input type="hidden" name="reason" value="${f.reason}">` : null
  }${f.spotCheck ? html`<input type="hidden" name="spot_check" value="1">` : null}`;

const csrfField = (v: Viewer) => html`<input type="hidden" name="csrf" value="${v.csrf}">`;

function layout(title: string, viewer: Viewer | null, body: SafeHtml, notice?: Notice): string {
  const header = viewer
    ? html`<header>
<strong>Review</strong>
<nav><a href="/review">Queue</a> <a href="/review/reviewed">Reviewed</a></nav>
<span class="who">Signed in as <b>${viewer.reviewer}</b></span>
<form method="post" action="/review/logout" class="inline">${csrfField(viewer)}<button type="submit">Log out</button></form>
</header>`
    : html`<header><strong>Review</strong></header>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · Review</title>
<link rel="stylesheet" href="/review/style.css">
</head>
<body>
${header}
<main>
${notice ? html`<p class="notice ${notice.kind}" role="status">${notice.text}</p>` : null}
${body}
</main>
</body>
</html>
`.toString();
}

export interface Notice {
  kind: "info" | "error";
  text: string;
}

// ---- Login ------------------------------------------------------------------------------------

export function loginPage(opts: { error?: string | undefined; reviewer?: string | undefined } = {}): string {
  const body = html`<h1>Log in</h1>
<form method="post" action="/review/login" class="stack">
<label>Review key <input type="password" name="key" required autocomplete="off"></label>
<label>Your reviewer handle <input type="text" name="reviewer" required value="${opts.reviewer ?? ""}" pattern="[a-z0-9][a-z0-9._\\-]{1,31}" autocomplete="username" placeholder="reviewer-1"></label>
<p class="hint">2–32 lower-case letters, digits, ".", "_" or "-". No real names.</p>
<button type="submit">Log in</button>
</form>`;
  return layout("Log in", null, body, opts.error ? { kind: "error", text: opts.error } : undefined);
}

// ---- Queue ------------------------------------------------------------------------------------

function classificationCell(r: { outcome: QueueRow["outcome"]; intent: Intent | null; confidence: number | null }) {
  if (r.outcome === null) return html`<span class="muted">not classified</span>`;
  if (r.outcome !== "valid") return html`<span class="muted">${r.outcome}</span>`;
  return html`${r.intent} <span class="muted">(${r.confidence})</span>`;
}

function filterForm(f: PageFilters): SafeHtml {
  return html`<form method="get" action="/review" class="filters">
<label>Team <select name="team"><option value="">any</option>${TEAMS.map(
    (t) => html`<option value="${t}"${f.team === t ? html` selected` : null}>${t}</option>`,
  )}</select></label>
<label>Reason <select name="reason"><option value="">any</option>${REASON_CODES.map(
    (r) => html`<option value="${r}"${f.reason === r ? html` selected` : null}>${r}</option>`,
  )}</select></label>
<label><input type="checkbox" name="spot_check" value="1"${f.spotCheck ? html` checked` : null}> Spot check (auto-routed cases)</label>
<button type="submit">Filter</button>
</form>`;
}

export function queuePage(opts: {
  viewer: Viewer;
  filters: PageFilters;
  total: number;
  rows: QueueRow[];
  skipped: readonly string[];
  /** The last row's case ID when there may be more rows. */
  nextAfter: string | null;
  notice?: Notice | undefined;
}): string {
  const { filters: f } = opts;
  const what = f.spotCheck ? "auto-routed cases not yet spot-checked" : "cases waiting for review";
  const rows = opts.rows.map(
    (r) => html`<tr>
<td><a href="/review/cases/${r.caseId}${filterParams(f)}">${r.externalId ?? r.caseId.slice(0, 13)}</a>${
      opts.skipped.includes(r.caseId) ? html` <span class="tag">skipped</span>` : null
    }</td>
<td>${iso(r.receivedAt)}</td>
<td>${r.channel}, ${r.language ?? "?"}</td>
<td>${classificationCell(r)}</td>
<td>${r.targetTeam}</td>
<td>${r.reasonCodes.length ? r.reasonCodes.join(", ") : html`<span class="muted">none</span>`}</td>
</tr>`,
  );
  const body = html`<h1>Queue</h1>
${filterForm(f)}
<p><strong>${opts.total}</strong> ${what}.${
    opts.total > 0 ? html` <a class="button" href="/review/next${filterParams(f)}">Start reviewing</a>` : null
  }</p>
${
  opts.rows.length
    ? html`<table>
<thead><tr><th>Message</th><th>Received</th><th>Channel</th><th>Classification</th><th>Team</th><th>Reasons</th></tr></thead>
<tbody>${rows}</tbody>
</table>`
    : null
}
${opts.nextAfter ? html`<p><a href="/review${filterParams(f, { after: opts.nextAfter })}">Next 50 →</a></p>` : null}`;
  return layout("Queue", opts.viewer, body, opts.notice);
}

export function emptyQueuePage(opts: { viewer: Viewer; filters: PageFilters; notice?: Notice | undefined }): string {
  const body = html`<h1>No cases to review</h1>
<p>Nothing in this queue${opts.filters.team || opts.filters.reason ? " with these filters" : ""} is left to ${
    opts.filters.spotCheck ? "spot-check" : "review"
  }. Cases you skipped come back after you log in again.</p>
<p><a href="/review${filterParams(opts.filters)}">Back to the queue</a></p>`;
  return layout("No cases", opts.viewer, body, opts.notice);
}

// ---- Case -------------------------------------------------------------------------------------

function definitionList(items: [string, HtmlValue][]): SafeHtml {
  return html`<dl>${items.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

function decisionSection(view: CaseView): SafeHtml {
  const c = view.case;
  const fired = (c.log.find((l) => l.step === "route")?.output.fired_rules ?? []) as {
    reason_code: string;
    detail: string;
  }[];
  return html`<section>
<h2>Decision</h2>
${definitionList([
  ["Team", c.targetTeam],
  ["Review", c.needsReview ? "needed" : "not needed (auto-routed; spot check)"],
  ["Router", c.routerVersion],
])}
${fired.length ? html`<ul class="reasons">${fired.map((r) => html`<li><code>${r.reason_code}</code>: ${r.detail}</li>`)}</ul>` : null}
</section>`;
}

function classificationSection(view: CaseView): SafeHtml {
  const cl = view.classification;
  let body: SafeHtml;
  if (!cl) body = html`<p>None: processing failed before classifying.</p>`;
  else if (cl.outcome !== "valid")
    body = html`<p><strong>${cl.outcome}</strong> (${cl.promptVersion} / ${cl.servedModel})</p>
<ul>${cl.errors.map((e) => html`<li>${e}</li>`)}</ul>`;
  else
    body = html`${definitionList([
      ["Intent", cl.intent],
      ["Confidence", cl.confidence],
      ["Urgency", cl.urgency],
      ["Service", cl.serviceType],
      ["Area", cl.area ?? "none"],
      ["Prompt / model", `${cl.promptVersion} / ${cl.servedModel}`],
    ])}
<p class="summary">${cl.summary}</p>`;
  return html`<section><h2>Classification</h2>${body}</section>`;
}

function messageSection(view: CaseView, rawText: RawText | undefined): SafeHtml {
  const masked =
    view.interaction.maskedText === null
      ? html`<p>Not masked: processing failed at masking. Unmask shows the raw text.</p>`
      : html`<pre class="message">${view.interaction.maskedText}</pre>`;
  const raw = rawText
    ? html`<div class="raw">
<h3>Raw text, unmask logged at ${iso(rawText.at)} by ${rawText.reviewer}</h3>
<pre class="message">${rawText.text}</pre>
<p class="hint">Shown once. Reloading the case shows the masked text again.</p>
</div>`
    : null;
  return html`<section><h2>Message (masked)</h2>${masked}${raw}</section>`;
}

function evidenceSection(view: CaseView): SafeHtml {
  const e = view.enrichment;
  if (!e) return html`<section><h2>Evidence</h2><p>Customer lookup: not run.</p></section>`;
  const customer = view.customer
    ? html`<p>Customer <code>${view.customer.id}</code> (${view.customer.segment})${
        e.candidates[0]?.placeholders.length ? `, matched by ${e.candidates[0].placeholders.join(", ")}` : ""
      }</p>
<ul>${view.customer.services.map((s) => html`<li>${s.service_type}, ${s.tariff}, ${s.area}, ${s.status}</li>`)}</ul>`
    : e.candidates.length
      ? html`<p>Candidates:</p><ul>${e.candidates.map(
          (c) => html`<li>customer <code>${c.customerId}</code>, matched by ${c.placeholders.join(", ")}</li>`,
        )}</ul>`
      : null;
  const outages = view.outages.length
    ? html`<ul>${view.outages.map(
        (o) =>
          html`<li>${o.area}, ${o.service_type}, since ${iso(o.started_at)} (${
            o.resolved_at ? `until ${iso(o.resolved_at)}` : "ongoing"
          }): ${o.description}</li>`,
      )}</ul>`
    : html`<p>Outages: ${e.area ? "none when the message arrived" : "not checked"}.</p>`;
  return html`<section>
<h2>Evidence</h2>
<p>Customer lookup: <strong>${e.outcome}</strong></p>
${customer}
${e.unmatchedPlaceholders.length ? html`<p>Not in the CRM: ${e.unmatchedPlaceholders.join(", ")}</p>` : null}
<p>Area: ${e.area ? `${e.area} (from the ${e.areaSource})` : "none"}</p>
${outages}
</section>`;
}

function investigationSection(view: CaseView): SafeHtml | null {
  const inv = view.investigation;
  if (!inv) return null;
  if ("skipped" in inv) return html`<section><h2>Investigation</h2><p>Not run (${inv.skipped}).</p></section>`;
  const turns = `${inv.steps} turn${inv.steps === 1 ? "" : "s"}`;
  const head =
    inv.outcome === "valid"
      ? html`<p>Likely cause <strong>${inv.likelyCause}</strong> (confidence ${inv.confidence}), ${turns}, ${inv.servedModel}</p>
<p class="summary">${inv.summary}</p>
<ul>${inv.evidence.map((e) => html`<li><code>${e.tool}</code> ${e.finding}</li>`)}</ul>`
      : html`<p><strong>${inv.outcome}</strong>, ${turns}, ${inv.servedModel}: ${inv.errors.join("; ")}</p>`;
  const calls = inv.toolCalls.length
    ? html`<p>Tools called:</p><ol class="calls">${inv.toolCalls.map(
        (t) =>
          html`<li>turn ${t.turn}: <code>${t.tool}</code> <code>${JSON.stringify(t.input)}</code>${
            t.is_error ? html` <span class="tag error">error</span>` : null
          }</li>`,
      )}</ol>`
    : html`<p>Tools called: none.</p>`;
  return html`<section><h2>Investigation</h2>${head}${calls}</section>`;
}

function logSection(view: CaseView): SafeHtml {
  return html`<section>
<h2>Decision log</h2>
<ol class="log">${view.case.log.map(
    (entry) => html`<li><code>${entry.step}</code> (${entry.ruleApplied}) ${describeStep(entry)}</li>`,
  )}</ol>
</section>`;
}

function unmaskingsSection(view: CaseView): SafeHtml | null {
  if (view.unmaskings.length === 0) return null;
  return html`<section>
<h2>Unmasked before</h2>
<ul>${view.unmaskings.map((u) => html`<li>${u.reviewer} at ${iso(u.unmaskedAt)}: ${u.reason}</li>`)}</ul>
</section>`;
}

function reviewSection(review: StoredReview): SafeHtml {
  return html`<section class="review">
<h2>Review</h2>
${definitionList([
  ["Decision", review.decision],
  ["Reviewer", review.reviewer],
  ["Reviewed at", iso(review.reviewedAt)],
  ...(review.decision === "corrected"
    ? ([
        ["Corrected intent", review.correctedIntent],
        ["Corrected team", review.correctedTeam],
      ] as [string, HtmlValue][])
    : []),
  ["Spot check", review.spotCheck ? "yes" : "no"],
  ["Note", review.note ?? html`<span class="muted">none</span>`],
])}
</section>`;
}

/** The value "the intent's team" in the correct form's team select. */
export const INTENT_TEAM = "auto";

function actionForms(opts: { view: CaseView; viewer: Viewer; filters: PageFilters; error?: FormError | undefined }) {
  const { view, viewer, filters: f } = opts;
  const id = view.case.id;
  const err = (form: FormName) =>
    opts.error?.form === form ? html`<p class="notice error" role="alert">${opts.error.message}</p>` : null;
  const val = (form: FormName, name: string) => (opts.error?.form === form ? (opts.error.values[name] ?? "") : "");
  const common = html`${csrfField(viewer)}${hiddenFilters(f)}`;
  const current = view.classification?.intent ?? null;
  const pickedIntent = val("correct", "intent");
  const pickedTeam = val("correct", "new_team") || INTENT_TEAM;

  return html`<section class="actions">
<h2>Decide</h2>
<form method="post" action="/review/cases/${id}/confirm" class="stack">
<h3>Confirm</h3>
${err("confirm")}${common}
<label>Note (optional) <textarea name="note" maxlength="${NOTE_MAX_LENGTH}" rows="2">${val("confirm", "note")}</textarea></label>
<button type="submit">Confirm</button>
</form>
<form method="post" action="/review/cases/${id}/correct" class="stack">
<h3>Correct</h3>
${err("correct")}${common}
<label>Intent <select name="intent" required><option value="">pick an intent</option>${INTENTS.map(
    (i) =>
      html`<option value="${i}"${pickedIntent === i ? html` selected` : null}>${i}${i === current ? " (current)" : ""}</option>`,
  )}</select></label>
<label>Team <select name="new_team"><option value="${INTENT_TEAM}"${pickedTeam === INTENT_TEAM ? html` selected` : null}>the intent's team</option>${TEAMS.map(
    (t) =>
      html`<option value="${t}"${pickedTeam === t ? html` selected` : null}>${t}${t === view.case.targetTeam ? " (current)" : ""}</option>`,
  )}</select></label>
<label>Note (required) <textarea name="note" required maxlength="${NOTE_MAX_LENGTH}" rows="2">${val("correct", "note")}</textarea></label>
<button type="submit">Correct</button>
</form>
<form method="post" action="/review/cases/${id}/skip" class="stack">
<h3>Skip</h3>
${common}
<p class="hint">Not stored. The case comes back after you log in again.</p>
<button type="submit">Skip</button>
</form>
<form method="post" action="/review/cases/${id}/unmask" class="stack">
<h3>Unmask</h3>
${err("unmask")}${common}
<label>Reason (required, logged) <input type="text" name="unmask_reason" required minlength="${REASON_MIN_LENGTH}" maxlength="${REASON_MAX_LENGTH}" value="${val("unmask", "unmask_reason")}"></label>
<button type="submit">Show the raw text</button>
</form>
</section>`;
}

export interface RawText {
  text: string;
  reviewer: string;
  at: Date;
}

export function casePage(opts: {
  viewer: Viewer;
  view: CaseView;
  /** The case's place in the queue; null when it isn't in it. */
  position: { index: number; total: number } | null;
  filters: PageFilters;
  error?: FormError | undefined;
  rawText?: RawText | undefined;
  notice?: Notice | undefined;
}): string {
  const { view, filters: f } = opts;
  const i = view.interaction;
  const title = i.externalId ?? view.case.id;
  const body = html`<p class="crumbs"><a href="/review${filterParams(f)}">← Queue</a>${
    opts.position ? html` · Case ${opts.position.index} of ${opts.position.total}` : null
  } · <a href="/review/next${filterParams(f)}">Next in queue →</a></p>
<h1>Case ${title}</h1>
${definitionList([
  ["Case", html`<code>${view.case.id}</code>`],
  ["Interaction", html`<code>${i.id}</code>${i.externalId ? ` (${i.externalId})` : ""}`],
  ["Channel", i.channel],
  ["Language", i.language ?? "unknown"],
  ["Received", iso(i.receivedAt)],
])}
${decisionSection(view)}
${classificationSection(view)}
${messageSection(view, opts.rawText)}
${evidenceSection(view)}
${investigationSection(view)}
${logSection(view)}
${unmaskingsSection(view)}
${view.review ? reviewSection(view.review) : actionForms(opts)}`;
  return layout(`Case ${title}`, opts.viewer, body, opts.notice);
}

// ---- Reviewed ---------------------------------------------------------------------------------

export function reviewedPage(opts: {
  viewer: Viewer;
  filters: ReviewedFilters;
  rows: ReviewedRow[];
  nextBefore: string | null;
}): string {
  const f = opts.filters;
  const params = (extra: Record<string, string | undefined> = {}) => {
    const p = new URLSearchParams();
    if (f.reviewer) p.set("reviewer", f.reviewer);
    if (f.decision) p.set("decision", f.decision);
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const rows = opts.rows.map((r) => {
    const changed =
      r.decision === "corrected"
        ? html`<br><span class="muted">was ${r.original.intent ?? "none"} → ${r.original.team}</span>`
        : null;
    return html`<tr>
<td><a href="/review/cases/${r.caseId}">${r.externalId ?? r.caseId.slice(0, 13)}</a></td>
<td>${iso(r.reviewedAt)}</td>
<td>${r.reviewer}</td>
<td>${r.decision}${r.spotCheck ? html` <span class="tag">spot check</span>` : null}</td>
<td>${r.effective.intent ?? "none"} → ${r.effective.team}${changed}</td>
<td>${r.note ?? html`<span class="muted">none</span>`}</td>
</tr>`;
  });
  const body = html`<h1>Reviewed cases</h1>
<form method="get" action="/review/reviewed" class="filters">
<label>Reviewer <input type="text" name="reviewer" value="${f.reviewer ?? ""}" pattern="[a-z0-9][a-z0-9._\\-]{1,31}"></label>
<label>Decision <select name="decision"><option value="">any</option>${REVIEW_DECISIONS.map(
    (d) => html`<option value="${d}"${f.decision === d ? html` selected` : null}>${d}</option>`,
  )}</select></label>
<button type="submit">Filter</button>
</form>
${
  opts.rows.length
    ? html`<table>
<thead><tr><th>Message</th><th>Reviewed</th><th>Reviewer</th><th>Decision</th><th>Intent → team</th><th>Note</th></tr></thead>
<tbody>${rows}</tbody>
</table>`
    : html`<p>No reviews${f.reviewer || f.decision ? " with these filters" : ""} yet.</p>`
}
${opts.nextBefore ? html`<p><a href="/review/reviewed${params({ before: opts.nextBefore })}">Older →</a></p>` : null}`;
  return layout("Reviewed", opts.viewer, body);
}

// ---- Stylesheet -------------------------------------------------------------------------------

/** Served at /review/style.css; the CSP allows styles from the page's own origin only. */
export const STYLESHEET = `:root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --accent: #1d4ed8; --error: #b91c1c; --bg-note: #eff6ff; --bg-raw: #fef3c7; }
@media (prefers-color-scheme: dark) { :root { --muted: #9ca3af; --line: #374151; --accent: #93c5fd; --error: #fca5a5; --bg-note: #1e293b; --bg-raw: #422006; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; padding: .6rem 1rem; border-bottom: 1px solid var(--line); }
header nav a { margin-right: .8rem; }
header .who { margin-left: auto; }
main { max-width: 72rem; margin: 0 auto; padding: 1rem; }
a { color: var(--accent); }
h1 { font-size: 1.4rem; margin: .5rem 0 1rem; }
h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; border-bottom: 1px solid var(--line); padding-bottom: .2rem; }
h3 { font-size: 1rem; margin: 0 0 .4rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
pre.message { white-space: pre-wrap; overflow-wrap: anywhere; padding: .8rem; border: 1px solid var(--line); border-radius: 4px; font-size: .95rem; }
.raw { background: var(--bg-raw); padding: .5rem .8rem; border-radius: 4px; margin-top: 1rem; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
.muted, .hint { color: var(--muted); }
.hint { font-size: .9rem; margin: .2rem 0; }
.tag { font-size: .8rem; border: 1px solid var(--line); border-radius: 3px; padding: 0 .3rem; }
.tag.error, .notice.error { color: var(--error); }
.notice { background: var(--bg-note); padding: .5rem .8rem; border-radius: 4px; }
.filters { display: flex; flex-wrap: wrap; gap: .8rem; align-items: end; margin-bottom: 1rem; }
form.inline { display: inline; }
form.stack { display: flex; flex-direction: column; gap: .4rem; padding: .8rem; border: 1px solid var(--line); border-radius: 4px; }
form.stack label { display: flex; flex-direction: column; gap: .2rem; }
.actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
.actions h2 { grid-column: 1 / -1; }
input, select, textarea, button { font: inherit; }
button, a.button { padding: .3rem .9rem; cursor: pointer; }
a.button { border: 1px solid var(--accent); border-radius: 4px; text-decoration: none; margin-left: .5rem; }
code { font-size: .9em; overflow-wrap: anywhere; }
`;
