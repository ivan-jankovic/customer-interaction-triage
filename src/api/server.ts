// Entry point of the intake API: `npm run dev` (tsx, from .env) or `npm start` / the Compose
// `app` service (compiled JS). Configuration: src/config.ts (loadApiConfig).

import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { loadApiConfig } from "../config.js";
import { createDb } from "../db/database.js";
import { KyselyInteractionStore } from "../db/interactions.js";
import { createQueue, enqueue } from "../queue.js";
import { buildApp } from "./app.js";

/**
 * Pino options. Fastify's request serializer logs method, URL and remote address only; bodies
 * (message text is personal data until masking, P05) are never logged. The key is redacted in
 * case a header ever gets logged, e.g. by a future serializer change.
 */
export const LOGGER_OPTIONS = {
  level: process.env.LOG_LEVEL ?? "info",
  // P13: the review page's session cookie too. Form bodies (notes, reasons, the review key) are
  // never logged either: the request serializer logs no body.
  redact: {
    paths: ['req.headers["x-api-key"]', "req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    censor: "[redacted]",
  },
};

async function main(): Promise<void> {
  const config = loadApiConfig();
  const db = createDb(config.databaseUrl);
  // BullMQ needs Redis up when the queue is created; after that, intake tolerates outages.
  const { queue, close: closeQueue } = createQueue(config.redisUrl, { forIntake: true });
  await queue.waitUntilReady();
  const app = buildApp({
    store: new KyselyInteractionStore(db),
    apiKey: config.intakeApiKey,
    checkDb: async () => {
      await sql`select 1`.execute(db);
    },
    enqueue: (id) => enqueue(queue, id),
    ...(config.reviewApiKey ? { review: { db, reviewKey: config.reviewApiKey } } : {}),
    logger: LOGGER_OPTIONS,
  });
  if (!config.reviewApiKey) app.log.info("review page disabled: REVIEW_API_KEY not set");

  const shutdown = (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    app
      .close()
      .then(() => closeQueue())
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
