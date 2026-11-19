// npm run investigate -- <id | external_id> [--dry-run]: runs the investigating agent (P10) for
// one stored technical fault, after `classify` and `enrich`, and prints what it found and every
// tool it called. Paid: the agent calls a model up to six times. Each run stores a new
// investigations row; the case (if any) keeps the investigation it was routed with.
//
// --dry-run prints the first request (system prompt, case and masked message) and counts its
// input tokens (free), without calling the model or storing anything.
//
// Prints placeholders and IDs, never identifier values: the output is meant to be pasted into a PR.

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Kysely } from "kysely";
import { loadDatabaseUrl, loadInvestigatorConfig } from "../config.js";
import { createDb, type Database } from "../db/database.js";
import {
  investigationInput,
  investigationInputs,
  NotReadyForInvestigation,
  runInvestigation,
  type StoredInvestigation,
} from "../db/investigations.js";
import { createAnthropicClient, type ConverseClient, type ConverseTokenCounter } from "../llm/client.js";
import { loadPrompt } from "../llm/prompts.js";
import { investigationOutputSchema, TOOL_DEFINITIONS } from "../llm/schemas/investigation.schema.js";
import {
  buildFirstMessage,
  INVESTIGATE_MAX_TOKENS,
  INVESTIGATE_MAX_TURNS,
  INVESTIGATE_PROMPT_VERSION,
} from "../pipeline/investigate.js";
import { findInteraction } from "./find-interaction.js";

export interface InvestigateCliDeps {
  db: Kysely<Database>;
  env: NodeJS.ProcessEnv;
  /** Tests pass a mock; otherwise the Anthropic client (only with ANTHROPIC_API_KEY). */
  createLlm?: () => ConverseClient & Partial<ConverseTokenCounter>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const usd = (n: number | null) => (n === null ? "unknown (no price for the serving model)" : `$${n.toFixed(5)}`);
const short = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The investigation as printed by this command (and the demo in the PR). */
export function describeInvestigation(i: StoredInvestigation): string[] {
  const lines = [`Outcome: ${i.outcome}`];
  if (i.outcome === "valid") {
    lines.push(`Likely cause: ${i.likelyCause} (confidence ${i.confidence})`, `Summary: ${i.summary}`);
    lines.push("Evidence:", ...i.evidence.map((e) => `  - [${e.tool}] ${e.finding}`));
  } else {
    lines.push(`Errors: ${i.errors.join("; ")}`);
  }
  lines.push(`Tool calls (${i.toolCalls.length} in ${i.steps} turn${i.steps === 1 ? "" : "s"}):`);
  for (const c of i.toolCalls) {
    lines.push(`  ${c.turn}. ${c.tool} ${JSON.stringify(c.input)} → ${c.is_error ? "ERROR " : ""}${short(c.result)}`);
  }
  if (i.toolCalls.length === 0) lines.push("  none");
  return lines;
}

/** Returns the exit code: 0 when an attempt was stored (or the dry run printed), 1 when not ready, 2 for usage errors. */
export async function runInvestigate(argv: string[], deps: InvestigateCliDeps): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "dry-run": { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const dryRun = values["dry-run"];
  if (positionals.length !== 1) {
    err("Usage: npm run investigate -- <interaction id | external_id> [--dry-run]");
    return 2;
  }
  const hasKey = Boolean(deps.env.ANTHROPIC_API_KEY?.trim());
  if (!dryRun && !hasKey && !deps.createLlm) {
    err("Missing ANTHROPIC_API_KEY. Set it in .env (see .env.example); investigating calls a paid model.");
    return 2;
  }
  const config = loadInvestigatorConfig(deps.env);
  const interaction = await findInteraction(deps.db, positionals[0]!);
  if (!interaction) {
    err(`No interaction with id or external_id "${positionals[0]}".`);
    return 2;
  }

  let inputs;
  try {
    inputs = await investigationInputs(deps.db, interaction.id);
  } catch (error) {
    if (error instanceof NotReadyForInvestigation) {
      err(error.message);
      return 1;
    }
    throw error;
  }
  const { classification, enrichment } = inputs;
  const prompt = loadPrompt(INVESTIGATE_PROMPT_VERSION);
  const llm = hasKey || deps.createLlm ? (deps.createLlm ?? createAnthropicClient)() : undefined;
  out(`Interaction ${interaction.id}${interaction.external_id ? ` (${interaction.external_id})` : ""}`);
  out(`Classification ${classification.id}, enrichment ${enrichment.id} (${enrichment.outcome}).`);

  if (dryRun) {
    const input = await investigationInput(deps.db, interaction.id, classification, enrichment);
    const first = buildFirstMessage(input, prompt);
    out(`=== system (${prompt.version}) ===\n${prompt.system}\n\n=== user ===\n${first}\n`);
    out(`Tools: ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}.`);
    out(
      `Model ${config.model}, effort ${config.effort}, at most ${INVESTIGATE_MAX_TURNS} turns of ${INVESTIGATE_MAX_TOKENS} max_tokens.`,
    );
    if (llm?.countConverseTokens) {
      const tokens = await llm.countConverseTokens({
        model: config.model,
        system: prompt.system,
        messages: [{ role: "user", content: first }],
        tools: TOOL_DEFINITIONS,
        schema: investigationOutputSchema,
        maxTokens: INVESTIGATE_MAX_TOKENS,
        effort: config.effort,
      });
      out(`Input tokens of the first turn (count_tokens, free): ${tokens}`);
    } else out("Set ANTHROPIC_API_KEY to also count the input tokens (free).");
    out("Dry run: nothing was investigated or stored.");
    return 0;
  }

  const stored = await runInvestigation(
    deps.db,
    { llm: llm!, ...config, prompt },
    interaction.id,
    classification,
    enrichment,
  );
  for (const line of describeInvestigation(stored)) out(line);
  out(`Model: ${stored.servedModel}, effort ${stored.effort}, prompt ${stored.promptVersion}`);
  const u = stored.usage;
  out(
    `Tokens: ${u.input_tokens} input, ${u.cache_read_input_tokens} cache read, ` +
      `${u.cache_creation_input_tokens} cache write, ${u.output_tokens} output`,
  );
  out(`Cost: ${usd(stored.costUsd)}, latency ${stored.latencyMs} ms`);
  out(`Stored as investigation ${stored.id}.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDb(loadDatabaseUrl());
  runInvestigate(process.argv.slice(2), { db, env: process.env })
    .then(
      (code) => (process.exitCode = code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    )
    .finally(() => void db.destroy());
}
