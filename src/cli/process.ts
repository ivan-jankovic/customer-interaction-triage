// npm run process -- <id | external_id>: runs the whole pipeline for one interaction now, with
// the same runner as the queue worker (P08): mask → classify → enrich → route, reusing every step
// already stored. Paid: one model call unless the interaction was classified before.
//
// It runs as the job's final attempt, so it always ends with a case: a transient model error goes
// to review (classification_error) instead of being retried, and any other error writes a
// failure case (processing_failed). Prints placeholders, never identifier values.

import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { loadClassifierConfig, loadDatabaseUrl } from "../config.js";
import { readCase } from "../db/cases.js";
import { createDb, type Database } from "../db/database.js";
import { createAnthropicClient, type LlmClient } from "../llm/client.js";
import { loadPrompt } from "../llm/prompts.js";
import { processInteraction } from "../pipeline/process.js";
import { CLASSIFY_PROMPT_VERSION } from "../pipeline/understand.js";
import { findInteraction } from "./find-interaction.js";
import { printCase } from "./route.js";

export interface ProcessCliDeps {
  db: Kysely<Database>;
  env: NodeJS.ProcessEnv;
  /** Created only when a model call may be needed; tests pass a mock. */
  createLlm?: () => LlmClient;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Returns the exit code: 0 when the interaction has a case, 2 for usage errors. */
export async function runProcess(argv: string[], deps: ProcessCliDeps): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (argv.length !== 1) {
    err("Usage: npm run process -- <interaction id | external_id>");
    return 2;
  }
  const interaction = await findInteraction(deps.db, argv[0]!);
  if (!interaction) {
    err(`No interaction with id or external_id "${argv[0]}".`);
    return 2;
  }

  const hasCase = (await readCase(deps.db, interaction.id)) !== null;
  if (!hasCase && !deps.createLlm && !deps.env.ANTHROPIC_API_KEY?.trim()) {
    err("Missing ANTHROPIC_API_KEY. Set it in .env (see .env.example); processing calls a paid model.");
    return 2;
  }
  const config = loadClassifierConfig(deps.env);
  // With a case, nothing runs, so no client is created.
  const llm: LlmClient = hasCase
    ? { complete: () => Promise.reject(new Error("no model call expected")) }
    : (deps.createLlm ?? createAnthropicClient)();

  const r = await processInteraction(
    deps.db,
    { llm, ...config, prompt: loadPrompt(CLASSIFY_PROMPT_VERSION) },
    interaction.id,
    { finalAttempt: true },
  );

  out(`Interaction ${interaction.id}${interaction.external_id ? ` (${interaction.external_id})` : ""}`);
  if (r.steps) {
    out(
      `Steps: ${Object.entries(r.steps)
        .map(([step, result]) => `${step} ${result}`)
        .join(", ")}`,
    );
  }
  if (r.failure) out(`Processing failed at ${r.failure.step} (${r.failure.errorClass}); failure case written.`);
  printCase(r.case, out);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDb(loadDatabaseUrl());
  runProcess(process.argv.slice(2), { db, env: process.env })
    .then(
      (code) => (process.exitCode = code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    )
    .finally(() => void db.destroy());
}
