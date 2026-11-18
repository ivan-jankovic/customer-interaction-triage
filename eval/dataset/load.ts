// Loads dataset messages into the system through the intake API (P02), the way any client would.
// Only external_id, channel, language and text are sent: labels stay in eval/data/, so the
// pipeline can never read the answers it is evaluated on.
//
// Usage: npm run dataset:load [-- --file eval/data/injection.jsonl]
// Needs the API running (docker compose up -d --wait, or npm run dev) and, in .env,
// INTAKE_API_KEY and optionally API_URL (default http://localhost:3000).

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { Channel, Language } from "../../src/taxonomy.js";
import { readJsonl } from "../lib/jsonl.js";
import { PATHS } from "../lib/paths.js";

/** The fields of a dataset or injection record the loader reads; everything else is ignored. */
interface SourceRecord {
  id: string;
  channel: Channel;
  language: Language;
  text: string;
}

export interface LoadOptions {
  file: string;
  apiUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface LoadReport {
  created: number;
  existing: number;
  failed: { id: string; reason: string }[];
}

/** The request body for one record: exactly these four fields. */
export function toRequest(record: SourceRecord) {
  return { external_id: record.id, channel: record.channel, language: record.language, text: record.text };
}

/** One request at a time: 100 messages take about a second, and the order stays readable in logs. */
export async function loadFile({
  file,
  apiUrl,
  apiKey,
  fetch: doFetch = fetch,
  log = console.log,
}: LoadOptions): Promise<LoadReport> {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const records = readJsonl<SourceRecord>(file);
  const url = new URL("/interactions", apiUrl).toString();
  const report: LoadReport = { created: 0, existing: 0, failed: [] };

  for (const record of records) {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(toRequest(record)),
      });
    } catch (error) {
      // Unreachable API: every further request would fail the same way.
      throw new Error(
        `Cannot reach the intake API at ${apiUrl} (${error instanceof Error ? error.message : String(error)}). ` +
          "Start it with `docker compose up -d --wait` or `npm run dev`.",
        { cause: error },
      );
    }
    if (response.status === 201) report.created++;
    else if (response.status === 200) report.existing++;
    else {
      const body = await response.text();
      const reason = `HTTP ${response.status}: ${body.slice(0, 200)}`;
      report.failed.push({ id: record.id, reason });
      log(`failed  ${record.id}  ${reason}`);
      // A wrong key fails every record; stop after the first instead of repeating it 100 times.
      if (response.status === 401) break;
    }
  }
  log(
    `${records.length} records in ${file}: ${report.created} created, ${report.existing} already present, ${report.failed.length} failed.`,
  );
  return report;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { file: { type: "string", default: PATHS.dataset } } });
  const apiKey = process.env.INTAKE_API_KEY?.trim();
  if (!apiKey) {
    console.error("Missing INTAKE_API_KEY. Set it in .env (see .env.example).");
    return 2;
  }
  const report = await loadFile({
    file: values.file,
    apiUrl: process.env.API_URL?.trim() || "http://localhost:3000",
    apiKey,
  });
  return report.failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
