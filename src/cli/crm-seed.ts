// npm run crm:seed [-- --file <seed.json>]: loads the mock CRM and outage list (P06) from
// eval/data/crm/seed.json into PostgreSQL, replacing whatever the mock tables held.
// Running it twice leaves the same rows. Free: no model is called.

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Kysely } from "kysely";
import { loadDatabaseUrl } from "../config.js";
import { CrmInUse, seedCrm } from "../db/crm.js";
import { CRM_SEED_PATH, readCrmSeed } from "../db/crm-seed.js";
import { createDb, type Database } from "../db/database.js";

export async function runCrmSeed(
  argv: string[],
  deps: { db: Kysely<Database>; out?: (line: string) => void; err?: (line: string) => void },
): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const { values } = parseArgs({ args: argv, options: { file: { type: "string", default: CRM_SEED_PATH } } });
  const seed = readCrmSeed(values.file);
  try {
    const counts = await seedCrm(deps.db, seed);
    out(
      `Loaded ${values.file} (${seed.generator}): ${counts.customers} customers, ${counts.services} services, ` +
        `${counts.tickets} tickets, ${counts.outages} outages, ${counts.lineStatus} line states.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof CrmInUse) {
      err(error.message);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDb(loadDatabaseUrl());
  runCrmSeed(process.argv.slice(2), { db })
    .then(
      (code) => (process.exitCode = code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    )
    .finally(() => void db.destroy());
}
