// One-line descriptions of decision-log entries, shared by `npm run route`, `npm run process` and
// the review loop (P09). IDs, outcomes and placeholders only, as stored in the log.

import type { DecisionLogEntry } from "../db/cases.js";

/** Log values are JSON scalars or arrays of strings. */
const show = (v: unknown) =>
  v === null || v === undefined
    ? "none"
    : Array.isArray(v)
      ? v.join(", ") || "none"
      : JSON.stringify(v).replace(/^"|"$/g, "");

/** One line per step, from the stored entry (IDs, outcomes and placeholders only). */
export function describeStep(entry: DecisionLogEntry): string {
  const o = entry.output;
  switch (entry.step) {
    case "mask": {
      const byType = o.placeholders as Record<string, string[]>;
      return `placeholders: ${show(Object.values(byType).flat())}`;
    }
    case "classify":
      return `${show(o.outcome)}; intent ${show(o.intent)}, confidence ${show(o.confidence)}, service ${show(o.service_type)}, area ${show(o.area)}`;
    case "enrich":
      return `${show(o.outcome)}; customer ${show(o.customer_id)}, unmatched ${show(o.unmatched_placeholders)}, area ${show(o.area)}, outages ${(o.outage_ids as string[]).length}`;
    case "route":
      return `team ${show(o.target_team)}, review ${o.needs_review ? "yes" : "no"}`;
  }
}
