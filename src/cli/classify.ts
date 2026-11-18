// Classifies one stored interaction (P03): npm run classify -- <id | external_id> [--dry-run]
//
// Without --dry-run this makes one paid model call and stores the attempt in classifications,
// whatever its outcome. --dry-run prints the prompt and its token count (the token-counting
// endpoint is free) and stores nothing.

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { loadClassifierConfig, loadDatabaseUrl } from "../config.js";
import { KyselyClassificationStore } from "../db/classifications.js";
import { createDb, type Database, type InteractionRow } from "../db/database.js";
import { createAnthropicClient, type LlmClient, type TokenCounter } from "../llm/client.js";
import { loadPrompt } from "../llm/prompts.js";
import { buildRequest, CLASSIFY_PROMPT_VERSION, understand } from "../pipeline/understand.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClassifyCliDeps {
  db: Kysely<Database>;
  env: NodeJS.ProcessEnv;
  /** Created only when needed; tests pass a mock. */
  createLlm?: () => LlmClient & TokenCounter;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

async function findInteraction(db: Kysely<Database>, ref: string): Promise<InteractionRow | undefined> {
  const query = db.selectFrom("interactions").selectAll();
  return UUID.test(ref)
    ? query.where("id", "=", ref).executeTakeFirst()
    : query.where("external_id", "=", ref).executeTakeFirst();
}

const usd = (n: number | null) => (n === null ? "unknown (no price for the serving model)" : `$${n.toFixed(5)}`);

/** Returns the exit code: 0 when an attempt was stored (or the dry run printed), 2 for usage errors. */
export async function runClassify(argv: string[], deps: ClassifyCliDeps): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "dry-run": { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const dryRun = values["dry-run"];
  if (positionals.length !== 1) {
    err("Usage: npm run classify -- <interaction id | external_id> [--dry-run]");
    return 2;
  }
  const hasKey = Boolean(deps.env.ANTHROPIC_API_KEY?.trim());
  if (!dryRun && !hasKey && !deps.createLlm) {
    err("Missing ANTHROPIC_API_KEY. Set it in .env (see .env.example); classifying calls a paid model.");
    return 2;
  }

  const config = loadClassifierConfig(deps.env);
  const interaction = await findInteraction(deps.db, positionals[0]!);
  if (!interaction) {
    err(`No interaction with id or external_id "${positionals[0]}".`);
    return 2;
  }

  const prompt = loadPrompt(CLASSIFY_PROMPT_VERSION);
  const input = { text: interaction.raw_text, channel: interaction.channel };
  const llm = hasKey || deps.createLlm ? (deps.createLlm ?? createAnthropicClient)() : undefined;

  if (dryRun) {
    const request = buildRequest(input, { ...config, prompt });
    out(`=== system (${prompt.version}) ===\n${request.system}\n\n=== user ===\n${request.user}\n`);
    out(`Model ${config.model}, effort ${config.effort}, max_tokens ${request.maxTokens}.`);
    if (llm) out(`Input tokens (count_tokens, free): ${await llm.countTokens(request)}`);
    else out("Set ANTHROPIC_API_KEY to also count the input tokens (free).");
    out("Dry run: nothing was classified or stored.");
    return 0;
  }

  const attempt = await understand(input, { llm: llm!, ...config, prompt });
  const stored = await new KyselyClassificationStore(deps.db).record(interaction.id, attempt);

  out(`Interaction ${interaction.id}${interaction.external_id ? ` (${interaction.external_id})` : ""}`);
  out(`Outcome: ${stored.outcome}`);
  if (stored.classification) out(JSON.stringify(stored.classification, null, 2));
  else out(`Errors: ${stored.errors.join("; ")}`);
  const fallback = stored.fellBack ? ` (fallback from ${stored.requestedModel})` : "";
  out(`Model: ${stored.servedModel}${fallback}, effort ${stored.effort}, prompt ${stored.promptVersion}`);
  const u = stored.usage;
  out(
    `Tokens: ${u.input_tokens} input, ${u.cache_read_input_tokens} cache read, ` +
      `${u.cache_creation_input_tokens} cache write, ${u.output_tokens} output`,
  );
  out(`Cost: ${usd(stored.costUsd)}, latency ${stored.latencyMs} ms`);
  out(`Stored as classification ${stored.id}.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDb(loadDatabaseUrl());
  runClassify(process.argv.slice(2), { db, env: process.env })
    .then(
      (code) => (process.exitCode = code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    )
    .finally(() => void db.destroy());
}
