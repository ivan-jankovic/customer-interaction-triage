// npm run enrich -- <id | external_id>: runs the enrichment step (P06) for one interaction and
// prints what it found. Free: no model is called. The interaction must already be masked and
// classified (npm run classify). Each run stores a new enrichments row.
//
// Prints placeholders, never identifier values: the output is meant to be pasted into a PR.

import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { loadDatabaseUrl } from "../config.js";
import { customerDetails, outagesByIds } from "../db/crm.js";
import { createDb, type Database } from "../db/database.js";
import { enrichInteraction, NotReadyForEnrichment } from "../db/enrichments.js";
import { findInteraction } from "./find-interaction.js";

export async function runEnrich(
  argv: string[],
  deps: { db: Kysely<Database>; out?: (line: string) => void; err?: (line: string) => void },
): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (argv.length !== 1) {
    err("Usage: npm run enrich -- <interaction id | external_id>");
    return 2;
  }
  const interaction = await findInteraction(deps.db, argv[0]!);
  if (!interaction) {
    err(`No interaction with id or external_id "${argv[0]}".`);
    return 2;
  }

  let e;
  try {
    e = await enrichInteraction(deps.db, interaction.id);
  } catch (error) {
    if (error instanceof NotReadyForEnrichment) {
      err(error.message);
      return 1;
    }
    throw error;
  }

  out(`Interaction ${interaction.id}${interaction.external_id ? ` (${interaction.external_id})` : ""}`);
  out(`Received ${interaction.received_at.toISOString()}; enriched with ${e.enricherVersion} (enrichment ${e.id}).`);
  out(`\nCustomer lookup: ${e.outcome}`);

  if (e.customerId) {
    const c = await customerDetails(deps.db, e.customerId);
    out(`  Customer ${c.id} (${c.segment}), matched by ${e.candidates[0]!.placeholders.join(", ")}`);
    out("  | Service | Tariff | Area | Status |\n  | --- | --- | --- | --- |");
    for (const s of c.services) out(`  | ${s.service_type} | ${s.tariff} | ${s.area} | ${s.status} |`);
  } else if (e.candidates.length > 0) {
    out("  Candidates:");
    for (const c of e.candidates) out(`  - customer ${c.customerId}, matched by ${c.placeholders.join(", ")}`);
  }
  if (e.unmatchedPlaceholders.length > 0) out(`  Not in the CRM: ${e.unmatchedPlaceholders.join(", ")}`);

  out(`\nArea: ${e.area ? `${e.area} (from the ${e.areaSource})` : "none"}`);
  const outages = await outagesByIds(deps.db, e.outageIds);
  if (outages.length === 0) out(e.area ? "Outages: none at the time the message arrived." : "Outages: not checked.");
  else {
    out("Outages:");
    for (const o of outages) {
      const until = o.resolved_at ? `until ${o.resolved_at.toISOString()}` : "ongoing";
      out(`  - ${o.area}, ${o.service_type}, since ${o.started_at.toISOString()} (${until}): ${o.description}`);
    }
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDb(loadDatabaseUrl());
  runEnrich(process.argv.slice(2), { db })
    .then(
      (code) => (process.exitCode = code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    )
    .finally(() => void db.destroy());
}
