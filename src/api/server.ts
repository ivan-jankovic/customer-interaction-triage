// Entry point of the intake API: `npm run dev` (tsx, from .env) or `npm start` / the Compose
// `app` service (compiled JS). Configuration: src/config.ts (loadApiConfig).

import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { loadApiConfig } from "../config.js";
import { createDb } from "../db/database.js";
import { KyselyInteractionStore } from "../db/interactions.js";
import { buildApp } from "./app.js";

/**
 * Pino options. Fastify's request serializer logs method, URL and remote address only; bodies
 * (message text is personal data until masking, P05) are never logged. The key is redacted in
 * case a header ever gets logged, e.g. by a future serializer change.
 */
export const LOGGER_OPTIONS = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ['req.headers["x-api-key"]', "req.headers.authorization"], censor: "[redacted]" },
};

async function main(): Promise<void> {
  const config = loadApiConfig();
  const db = createDb(config.databaseUrl);
  const app = buildApp({
    store: new KyselyInteractionStore(db),
    apiKey: config.intakeApiKey,
    checkDb: async () => {
      await sql`select 1`.execute(db);
    },
    logger: LOGGER_OPTIONS,
  });

  const shutdown = (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    app
      .close()
      .then(() => db.destroy())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, "shutdown failed");
          process.exit(1);
        },
      );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await app.listen({ host: config.host, port: config.port });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // Configuration errors are written for people (e.g. the missing INTAKE_API_KEY), so print the message.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
