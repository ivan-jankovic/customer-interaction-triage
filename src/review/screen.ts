// The review loop's screen (P09 requirements.md, "What show prints"): pure functions from a case
// view to lines of text, so the layout is unit-tested. Masked text only, and no identifier values:
// the case view holds none (src/review/case-view.ts).

import { describeStep } from "../format/decision-log.js";
import { INTENTS, TEAMS, type Intent, type Team } from "../taxonomy.js";
import type { CaseView } from "./case-view.js";

export const ACTION_PROMPT = "[c]onfirm  co[r]rect  [s]kip  [u]nmask  [q]uit > ";

const iso = (d: Date) => d.toISOString();
const indent = (text: string, by = "  ") =>
  text
    .split(/\r?\n/)
    .map((l) => by + l)
    .join("\n");

export function renderCase(view: CaseView, position: { index: number; total: number }): string[] {
  const { case: c, interaction: i, classification: cl, enrichment: e } = view;
  const lines: string[] = [];
  lines.push(`Case ${position.index} of ${position.total}  ${c.id}`);
  lines.push(
    `Interaction ${i.id}${i.externalId ? ` (${i.externalId})` : ""}: ${i.channel}, ${i.language ?? "language unknown"}, received ${iso(i.receivedAt)}`,
  );

  lines.push("");
  lines.push(`Team: ${c.targetTeam}    Review: ${c.needsReview ? "needed" : "not needed (auto-routed; spot check)"}`);
  const fired = (c.log.find((l) => l.step === "route")?.output.fired_rules ?? []) as {
    reason_code: string;
    detail: string;
  }[];
  for (const r of fired) lines.push(`  - ${r.reason_code}: ${r.detail}`);

  lines.push("");
  if (!cl) {
    lines.push("Classification: none (processing failed before classifying)");
  } else if (cl.outcome !== "valid") {
    lines.push(`Classification: ${cl.outcome} (${cl.promptVersion} / ${cl.servedModel}): ${cl.errors.join("; ")}`);
  } else {
    lines.push(
      `Classification: intent ${cl.intent} (confidence ${cl.confidence}), urgency ${cl.urgency}, service ${cl.serviceType}, area ${cl.area ?? "none"}`,
    );
    lines.push(`Summary: ${cl.summary}`);
  }

  lines.push("");
  if (i.maskedText === null) {
    lines.push("Message: not masked (processing failed at masking); [u]nmask shows the raw text.");
  } else {
    lines.push("Message (masked):");
    lines.push(indent(i.maskedText));
  }

  lines.push("");
  if (!e) {
    lines.push("Customer lookup: not run");
  } else {
    lines.push(`Customer lookup: ${e.outcome}`);
    if (view.customer) {
      const matched = e.candidates[0]?.placeholders.join(", ");
      lines.push(
        `  Customer ${view.customer.id} (${view.customer.segment})${matched ? `, matched by ${matched}` : ""}`,
      );
      for (const s of view.customer.services) {
        lines.push(`    ${s.service_type}, ${s.tariff}, ${s.area}, ${s.status}`);
      }
    } else if (e.candidates.length > 0) {
      lines.push("  Candidates:");
      for (const cand of e.candidates) {
        lines.push(`    customer ${cand.customerId}, matched by ${cand.placeholders.join(", ")}`);
      }
    }
    if (e.unmatchedPlaceholders.length > 0) lines.push(`  Not in the CRM: ${e.unmatchedPlaceholders.join(", ")}`);
    lines.push(`Area: ${e.area ? `${e.area} (from the ${e.areaSource})` : "none"}`);
    if (view.outages.length === 0)
      lines.push(e.area ? "Outages: none when the message arrived" : "Outages: not checked");
    for (const o of view.outages) {
      const until = o.resolved_at ? `until ${iso(o.resolved_at)}` : "ongoing";
      lines.push(`Outage: ${o.area}, ${o.service_type}, since ${iso(o.started_at)} (${until}): ${o.description}`);
    }
  }

  lines.push("");
  lines.push("Decision log:");
  for (const entry of c.log)
    lines.push(`  ${entry.seq}. ${entry.step.padEnd(8)} (${entry.ruleApplied}) ${describeStep(entry)}`);

  if (view.unmaskings.length > 0) {
    lines.push("");
    lines.push("Unmasked before:");
    for (const u of view.unmaskings) lines.push(`  ${u.reviewer} at ${iso(u.unmaskedAt)}: ${u.reason}`);
  }
  return lines;
}

export function intentMenu(current: Intent | null): string[] {
  return INTENTS.map((intent, n) => `  ${n + 1}. ${intent}${intent === current ? "  (current)" : ""}`);
}

export function teamMenu(current: Team, suggested: Team): string[] {
  return TEAMS.map(
    (team, n) =>
      `  ${n + 1}. ${team}${team === suggested ? "  (default)" : ""}${team === current ? "  (current)" : ""}`,
  );
}

/** "1".."n" → the nth item, anything else → null. */
export function pick<T>(items: readonly T[], answer: string): T | null {
  const n = Number(answer.trim());
  return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1]! : null;
}
