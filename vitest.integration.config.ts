import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig } from "vitest/config";

/**
 * The Redis outage tests stop and start the Compose Redis (P08), so they run after every other
 * file. Files already run one after another; this only fixes which one comes last (the default
 * order depends on cached durations).
 */
class OutageLastSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const isOutage = (f: TestSpecification) => f.moduleId.endsWith("redis-outage.int.test.ts");
    return [...sorted.filter((f) => !isOutage(f)), ...sorted.filter(isOutage)];
  }
}

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
    sequence: { sequencer: OutageLastSequencer },
    testTimeout: 20_000,
  },
});
