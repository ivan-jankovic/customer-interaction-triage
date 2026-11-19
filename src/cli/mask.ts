// npm run mask -- <id | external_id>: runs the masking step for one interaction (P05) and
// prints the raw text, the masked text and the placeholders. Free: no model is called.
// The masking is stored, like in processing; a second run shows the stored result.

import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { loadDatabaseUrl } from "../config.js";
import { createDb, type Database } from "../db/database.js";
import { maskInteraction } from "../db/masking.js";
import { findInteraction } from "./find-interaction.js";

export async function runMask(
  argv: string[],
  deps: { db: Kysely<Database>; out?: (line: string) => void; err?: (line: string) => void },
): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (argv.length !== 1) {
    err("Usage: npm run mask -- <interaction id | external_id>");
    return 2;
  }
  const interaction = await findInteraction(deps.db, argv[0]!);
  if (!interaction) {
    err(`No interaction with id or external_id "${argv[0]}".`);
    return 2;
  }
  const m = await maskInteraction(deps.db, interaction.id);
  out(`Interaction ${interaction.id}${interaction.external_id ? ` (${interaction.external_id})` : ""}`);
  out(
    `Masked with ${m.maskerVersion}, ${m.stored === "now" ? "now" : `stored earlier (${m.maskedAt.toISOString()})`}.`,
  );
  out(`\n=== raw ===\n${interaction.raw_text}\n\n=== masked ===\n${m.maskedText}\n`);
  if (m.identifiers.length === 0) out("No identifiers found.");
  else {
    out("| Placeholder | Type | Value |\n| --- | --- | --- |");
    for (const i of m.identifiers) out(`| ${i.placeholder} | ${i.type} | ${i.value} |`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDb(loadDatabaseUrl());
  runMask(process.argv.slice(2), { db })
    .then(
      (code) => (process.exitCode = code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    )
    .finally(() => void db.destroy());
}
