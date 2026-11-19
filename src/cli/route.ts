// npm run route -- <id | external_id>: runs the routing step (P07) for one interaction and prints
// its case and decision log. Free: no model is called. The interaction must already be
// classified (npm run classify) and, when the classification is valid, enriched (npm run enrich).
// One case per interaction: a second run prints the existing case and writes nothing.
//
// Prints placeholders, never identifier values: the output is meant to be pasted into a PR.

import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { loadDatabaseUrl } from "../config.js";
import { NotReadyForRouting, routeInteraction, type DecisionLogEntry } from "../db/cases.js";
import { createDb, type Database } from "../db/database.js";
import { findInteraction } from "./find-interaction.js";

/** Log values are JSON scalars or arrays of strings. */
const show = (v: unknown) =>
  v === null || v === undefined
    ? "none"
    : Array.isArray(v)
      ? v.join(", ") || "none"
      : JSON.stringify(v).replace(/^"|"$/g, "");

/** One line per step, from the stored entry (IDs, outcomes and placeholders only). */
function describeStep(entry: DecisionLogEntry): string {
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

export async function runRoute(
  argv: string[],
  deps: { db: Kysely<Database>; out?: (line: string) => void; err?: (line: string) => void },
): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (argv.length !== 1) {
    err("Usage: npm run route -- <interaction id | external_id>");
    return 2;
  }
  const interaction = await findInteraction(deps.db, argv[0]!);
  if (!interaction) {
    err(`No interaction with id or external_id "${argv[0]}".`);
    return 2;
  }

  let c;
  try {
    c = await routeInteraction(deps.db, interaction.id);
  } catch (error) {
    if (error instanceof NotReadyForRouting) {
      err(error.message);
      return 1;
    }
    throw error;
  }

  out(`Interaction ${interaction.id}${interaction.external_id ? ` (${interaction.external_id})` : ""}`);
  out(
    c.created
      ? `Case ${c.id}, routed with ${c.routerVersion}.`
      : `Case ${c.id}: existing case, routed with ${c.routerVersion} at ${c.createdAt.toISOString()}; nothing written.`,
  );
  out(`\nTeam: ${c.targetTeam}`);
  out(`Review: ${c.needsReview ? "yes" : "no"}`);
  const fired = (c.log.find((l) => l.step === "route")?.output.fired_rules ?? []) as {
    reason_code: string;
    detail: string;
  }[];
  for (const r of fired) out(`  - ${r.reason_code}: ${r.detail}`);
  if (c.customerId) out(`Customer: ${c.customerId}`);

  out("\nDecision log:");
  for (const entry of c.log)
    out(`  ${entry.seq}. ${entry.step.padEnd(8)} (${entry.ruleApplied}) ${describeStep(entry)}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDb(loadDatabaseUrl());
  runRoute(process.argv.slice(2), { db })
    .then(
      (code) => (process.exitCode = code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    )
    .finally(() => void db.destroy());
}
