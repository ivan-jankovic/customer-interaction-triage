// Review decisions are appended to eval/data/.work/review-log.jsonl, one line per
// decision, so a review session can stop and resume at any point. The interactive loop
// takes its input and output as functions, so it can be tested with scripted answers.

import { INTENTS, SERVICE_TYPES, URGENCY, type ReviewReason } from "../../src/taxonomy.js";
import type { Labels } from "../schema/labels.schema.js";
import { labelRuleErrors } from "../schema/validate.js";
import { labelsFromGrader, normaliseLabels, type AssembledRecord } from "./assemble.js";

export type ReviewOutcome = "accepted" | "corrected" | "rewrite_requested";

export interface ReviewLogEntry {
  id: string;
  /** Generation attempt the decision applies to; a rewrite makes older decisions stale. */
  attempt: number;
  outcome: ReviewOutcome;
  /** Final labels for accepted/corrected; null for a rewrite request. */
  final: Labels | null;
  changed_fields: string[];
  note: string | null;
  reviewed_at: string;
}

export interface ReviewIo {
  ask(question: string): Promise<string>;
  print(line: string): void;
}

const FIELD_ORDER = ["intent", "urgency", "must_review", "review_reasons", "service_type", "area"] as const;

function flat(l: Labels): Record<(typeof FIELD_ORDER)[number], string> {
  return {
    intent: l.intent,
    urgency: l.urgency,
    must_review: String(l.must_review),
    review_reasons: l.review_reasons.join(",") || "-",
    service_type: l.fields.service_type,
    area: l.fields.area ?? "-",
  };
}

/** Labelled fields that differ between two label sets (identifiers excluded: they are fixed by the plan). */
export function changedFields(chosen: Labels, final: Labels): string[] {
  const a = flat(chosen);
  const b = flat(final);
  return FIELD_ORDER.filter((f) => a[f] !== b[f]);
}

export function decision(a: AssembledRecord, final: Labels | null, outcome: ReviewOutcome | null, note: string | null): ReviewLogEntry {
  const changed = final ? changedFields(a.record.chosen, final) : [];
  return {
    id: a.record.id,
    attempt: a.record.plan.attempt,
    outcome: outcome ?? (changed.length ? "corrected" : "accepted"),
    final,
    changed_fields: changed,
    note,
    reviewed_at: new Date().toISOString(),
  };
}

export function renderRecord(a: AssembledRecord, position: string): string[] {
  const r = a.record;
  const lines: string[] = [];
  const why = [
    a.invalidGrader ? "invalid grader output" : null,
    a.mismatchFields.length ? `disagreement on ${a.mismatchFields.join(", ")}` : null,
    r.review.sampled ? "random agreement sample" : null,
    r.id.startsWith("inj-") ? `injection (${r.attack?.tactic} → ${r.attack?.goal})` : null,
  ].filter(Boolean);
  lines.push("", "═".repeat(78), `${position}  ${r.id}  ${r.channel}/${r.language}/${r.plan.register}  attempt ${r.plan.attempt}`);
  lines.push(`Why: ${why.join("; ")}${r.plan.designed_ambiguous ? "  [designed ambiguous]" : ""}${r.plan.mixed_language ? "  [mixed cs/sk]" : ""}`);
  lines.push("─".repeat(78), r.text, "─".repeat(78));
  const columns: [string, Labels | null][] = [["chosen", r.chosen]];
  r.graders.forEach((g, i) => columns.push([`${i === 0 ? "A" : "B"} ${g.model.replace("claude-", "")}`, g.output ? labelsFromGrader(g.output, r.chosen) : null]));
  lines.push(["field".padEnd(15), ...columns.map(([name]) => name.padEnd(22))].join(""));
  for (const f of FIELD_ORDER) {
    const values = columns.map(([, l]) => (l ? flat(l)[f] : "(invalid)"));
    const differs = new Set(values).size > 1;
    lines.push([(differs ? "≠ " : "  ") + f.padEnd(13), ...values.map((v) => v.padEnd(22))].join(""));
  }
  lines.push(`  identifiers   ${r.chosen.fields.identifiers.map((i) => `${i.type}=${i.value}`).join(", ") || "-"}`);
  r.graders.forEach((g, i) => lines.push(`  ${i === 0 ? "A" : "B"} rationale: ${g.output?.rationale ?? "(invalid output)"}`));
  return lines;
}

async function pickEnum<T extends string>(io: ReviewIo, name: string, options: readonly T[], current: T): Promise<T> {
  for (;;) {
    const answer = (await io.ask(`  ${name} [${options.join("/")}] (enter = ${current}): `)).trim();
    if (answer === "") return current;
    const match = options.find((o) => o === answer || o.startsWith(answer));
    if (match) return match;
    io.print(`  "${answer}" is not one of ${options.join(", ")}`);
  }
}

/** Field-by-field editing, starting from the given labels. */
export async function editLabels(io: ReviewIo, start: Labels): Promise<Labels> {
  const intent = await pickEnum(io, "intent", INTENTS, start.intent);
  const urgency = await pickEnum(io, "urgency", URGENCY, start.urgency);
  const unclearNow = start.review_reasons.includes("unclear") ? "yes" : "no";
  const unclear = (await pickEnum(io, "unclear", ["yes", "no"] as const, unclearNow)) === "yes";
  const service_type = await pickEnum(io, "service_type", SERVICE_TYPES, start.fields.service_type);
  const areaAnswer = (await io.ask(`  area (enter = ${start.fields.area ?? "-"}, "-" = none): `)).trim();
  const area = areaAnswer === "" ? start.fields.area : areaAnswer === "-" ? null : areaAnswer;
  const reasons: ReviewReason[] = unclear ? ["unclear"] : [];
  return normaliseLabels({
    ...start,
    intent,
    urgency,
    review_reasons: reasons,
    fields: { ...start.fields, service_type, area },
  });
}

const HELP =
  "  a = accept chosen   1 = take grader A   2 = take grader B   e = edit   r = rewrite message   s = skip   q = quit";

/**
 * Reviews the queue one record at a time. Each decision is passed to `save` immediately.
 * Returns the number of decisions made.
 */
export async function reviewLoop(queue: readonly AssembledRecord[], io: ReviewIo, save: (e: ReviewLogEntry) => void): Promise<number> {
  let made = 0;
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i]!;
    for (const line of renderRecord(a, `[${i + 1}/${queue.length}]`)) io.print(line);
    io.print(HELP);
    let done = false;
    while (!done) {
      const choice = (await io.ask("> ")).trim().toLowerCase();
      let final: Labels | null = null;
      if (choice === "q") return made;
      if (choice === "s") break;
      if (choice === "a") final = normaliseLabels(a.record.chosen);
      else if (choice === "1" || choice === "2") {
        const g = a.record.graders[Number(choice) - 1];
        if (!g?.output) {
          io.print("  That grader has no valid answer.");
          continue;
        }
        final = labelsFromGrader(g.output, a.record.chosen);
      } else if (choice === "e") final = await editLabels(io, a.record.chosen);
      else if (choice === "r") {
        const note = (await io.ask("  What should change in the rewrite? ")).trim();
        save(decision(a, null, "rewrite_requested", note || null));
        made++;
        done = true;
        continue;
      } else {
        io.print(HELP);
        continue;
      }
      const errors = labelRuleErrors(final);
      if (errors.length) {
        io.print(`  Labels break a rule: ${errors.join("; ")}`);
        continue;
      }
      const note = (await io.ask("  Note (optional): ")).trim();
      const entry = decision(a, final, null, note || null);
      save(entry);
      made++;
      io.print(`  Saved: ${entry.outcome}${entry.changed_fields.length ? ` (${entry.changed_fields.join(", ")})` : ""}`);
      done = true;
    }
  }
  return made;
}
