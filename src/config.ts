// Runtime configuration from environment variables. Values for local development are in
// .env.example; scripts load .env with `--env-file-if-exists=.env`.

import { EFFORTS, type Effort } from "./llm/client.js";
import { hasPrice } from "./llm/pricing.js";

export interface ServiceConfig {
  databaseUrl: string;
  redisUrl: string;
}

export interface ApiConfig {
  databaseUrl: string;
  /** Intake enqueues each stored interaction (P08). */
  redisUrl: string;
  intakeApiKey: string;
  host: string;
  port: number;
}

/** Shorter keys are rejected so a placeholder like "secret" can't end up in use. */
export const MIN_API_KEY_LENGTH = 32;

const ENV_HINT = "Copy the values from .env.example into .env (they match docker-compose.yml).";

function requireVars(env: NodeJS.ProcessEnv, names: string[]): string[] {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing environment variable${missing.length > 1 ? "s" : ""} ${missing.join(", ")}. ${ENV_HINT}`);
  }
  return names.map((name) => env[name]!.trim());
}

/** Reads the service URLs, failing with one message that names every missing variable. */
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const [databaseUrl, redisUrl] = requireVars(env, ["DATABASE_URL", "REDIS_URL"]) as [string, string];
  return { databaseUrl, redisUrl };
}

/** Only the database URL, for the migrator (the Compose `migrate` service has no Redis). */
export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return requireVars(env, ["DATABASE_URL"])[0]!;
}

/** Configuration of the intake API (src/api/server.ts). */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const [databaseUrl, redisUrl, intakeApiKey] = requireVars(env, ["DATABASE_URL", "REDIS_URL", "INTAKE_API_KEY"]) as [
    string,
    string,
    string,
  ];
  if (intakeApiKey.length < MIN_API_KEY_LENGTH) {
    throw new Error(
      `INTAKE_API_KEY must be at least ${MIN_API_KEY_LENGTH} characters. Generate one with: openssl rand -hex 32`,
    );
  }
  const portText = env.PORT?.trim() || "3000";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be a whole number from 1 to 65535, got "${portText}".`);
  }
  return { databaseUrl, redisUrl, intakeApiKey, host: env.HOST?.trim() || "127.0.0.1", port };
}

export interface ClassifierConfig {
  model: string;
  effort: Effort;
}

/**
 * The understanding step's model and effort (P03): claude-opus-5-5 at effort low unless
 * TRIAGE_MODEL / TRIAGE_EFFORT say otherwise. The model must have a price in
 * src/llm/pricing.ts, so every run's cost can be reported.
 */
export function loadClassifierConfig(env: NodeJS.ProcessEnv = process.env): ClassifierConfig {
  const model = env.TRIAGE_MODEL?.trim() || "claude-opus-5-5";
  const effort = env.TRIAGE_EFFORT?.trim() || "low";
  if (!hasPrice(model)) {
    throw new Error(`TRIAGE_MODEL "${model}" has no price in src/llm/pricing.ts; add it there first.`);
  }
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`TRIAGE_EFFORT must be one of ${EFFORTS.join(", ")}, got "${effort}".`);
  }
  return { model, effort: effort as Effort };
}

/**
 * The investigating agent's model and effort (P10): TRIAGE_MODEL / TRIAGE_EFFORT (so the same
 * as the classifier) unless INVESTIGATE_MODEL / INVESTIGATE_EFFORT say otherwise. Priced, like
 * the classifier's.
 */
export function loadInvestigatorConfig(env: NodeJS.ProcessEnv = process.env): ClassifierConfig {
  const base = loadClassifierConfig(env);
  const model = env.INVESTIGATE_MODEL?.trim() || base.model;
  const effort = env.INVESTIGATE_EFFORT?.trim() || base.effort;
  if (!hasPrice(model)) {
    throw new Error(`INVESTIGATE_MODEL "${model}" has no price in src/llm/pricing.ts; add it there first.`);
  }
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`INVESTIGATE_EFFORT must be one of ${EFFORTS.join(", ")}, got "${effort}".`);
  }
  return { model, effort: effort as Effort };
}

export interface WorkerConfig extends ServiceConfig, ClassifierConfig {
  concurrency: number;
  investigator: ClassifierConfig;
}

/**
 * Configuration of the queue worker (src/worker.ts, P08). It calls a paid model for every
 * message it processes, so it refuses to start without ANTHROPIC_API_KEY.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const [databaseUrl, redisUrl] = requireVars(env, ["DATABASE_URL", "REDIS_URL", "ANTHROPIC_API_KEY"]) as [
    string,
    string,
  ];
  const text = env.WORKER_CONCURRENCY?.trim() || "4";
  const concurrency = Number(text);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error(`WORKER_CONCURRENCY must be a whole number from 1 to 32, got "${text}".`);
  }
  return {
    databaseUrl,
    redisUrl,
    concurrency,
    ...loadClassifierConfig(env),
    investigator: loadInvestigatorConfig(env),
  };
}
