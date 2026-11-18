// Runtime configuration from environment variables. Values for local development are in
// .env.example; scripts load .env with `--env-file-if-exists=.env`.

export interface ServiceConfig {
  databaseUrl: string;
  redisUrl: string;
}

export interface ApiConfig {
  databaseUrl: string;
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
  const [databaseUrl, intakeApiKey] = requireVars(env, ["DATABASE_URL", "INTAKE_API_KEY"]) as [string, string];
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
  return { databaseUrl, intakeApiKey, host: env.HOST?.trim() || "127.0.0.1", port };
}
