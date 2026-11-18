// Runtime configuration from environment variables. Values for local development are in
// .env.example; scripts load .env with `--env-file-if-exists=.env`.

export interface ServiceConfig {
  databaseUrl: string;
  redisUrl: string;
}

const REQUIRED = { databaseUrl: "DATABASE_URL", redisUrl: "REDIS_URL" } as const;

/** Reads the service URLs, failing with one message that names every missing variable. */
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const missing = Object.values(REQUIRED).filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(
      `Missing environment variable${missing.length > 1 ? "s" : ""} ${missing.join(", ")}. ` +
        "Copy the values from .env.example into .env (they match docker-compose.yml).",
    );
  }
  return { databaseUrl: env[REQUIRED.databaseUrl]!.trim(), redisUrl: env[REQUIRED.redisUrl]!.trim() };
}
