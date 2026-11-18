import { defineConfig } from "vitest/config";

// Integration tests against the services in docker-compose.yml (`docker compose up -d --wait`).
// The URLs default to the Compose defaults, so neither CI nor a fresh checkout needs a .env;
// set DATABASE_URL / REDIS_URL to point elsewhere.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.int.test.ts"],
    setupFiles: ["test/setup/no-model-calls.ts"],
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://triage:triage@localhost:5432/triage",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    },
    // The tests share one PostgreSQL server and one Redis; run files one after another.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
