import { defineConfig } from "vitest/config";

// Unit tests only: they run anywhere, without Docker. Integration tests (test/integration/)
// need the Compose services and run with `npm run test:integration` (vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**"],
    setupFiles: ["test/setup/no-model-calls.ts"],
  },
});
