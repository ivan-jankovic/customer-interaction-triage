import { describe, expect, it } from "vitest";
import { loadServiceConfig } from "../src/config.js";

const DB = "postgres://triage:triage@localhost:5432/triage";
const REDIS = "redis://localhost:6379";

describe("loadServiceConfig", () => {
  it("returns both URLs when they are set", () => {
    expect(loadServiceConfig({ DATABASE_URL: DB, REDIS_URL: ` ${REDIS} ` })).toEqual({
      databaseUrl: DB,
      redisUrl: REDIS,
    });
  });

  it("names a single missing variable and points to .env.example", () => {
    expect(() => loadServiceConfig({ DATABASE_URL: DB })).toThrow(
      /^Missing environment variable REDIS_URL\. Copy the values from \.env\.example/,
    );
  });

  it("names every missing or empty variable at once", () => {
    expect(() => loadServiceConfig({ DATABASE_URL: "  " })).toThrow(
      "Missing environment variables DATABASE_URL, REDIS_URL.",
    );
  });
});
