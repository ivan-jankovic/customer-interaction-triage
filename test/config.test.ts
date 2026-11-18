import { describe, expect, it } from "vitest";
import { loadApiConfig, loadDatabaseUrl, loadServiceConfig } from "../src/config.js";

const DB = "postgres://triage:triage@localhost:5432/triage";
const REDIS = "redis://localhost:6379";
const KEY = "k".repeat(32);

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

describe("loadDatabaseUrl", () => {
  it("needs only DATABASE_URL", () => {
    expect(loadDatabaseUrl({ DATABASE_URL: DB })).toBe(DB);
    expect(() => loadDatabaseUrl({ REDIS_URL: REDIS })).toThrow("Missing environment variable DATABASE_URL.");
  });
});

describe("loadApiConfig", () => {
  it("uses localhost:3000 by default", () => {
    expect(loadApiConfig({ DATABASE_URL: DB, INTAKE_API_KEY: KEY })).toEqual({
      databaseUrl: DB,
      intakeApiKey: KEY,
      host: "127.0.0.1",
      port: 3000,
    });
  });

  it("reads HOST and PORT", () => {
    expect(loadApiConfig({ DATABASE_URL: DB, INTAKE_API_KEY: KEY, HOST: "0.0.0.0", PORT: "8080" })).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
    });
  });

  it("refuses to start without an API key", () => {
    expect(() => loadApiConfig({ DATABASE_URL: DB })).toThrow("Missing environment variable INTAKE_API_KEY.");
  });

  it("refuses a key shorter than 32 characters", () => {
    expect(() => loadApiConfig({ DATABASE_URL: DB, INTAKE_API_KEY: "k".repeat(31) })).toThrow(
      /at least 32 characters.*openssl rand -hex 32/,
    );
  });

  it.each(["0", "70000", "abc", "80.5"])("rejects PORT=%s", (port) => {
    expect(() => loadApiConfig({ DATABASE_URL: DB, INTAKE_API_KEY: KEY, PORT: port })).toThrow(/^PORT must be/);
  });
});
