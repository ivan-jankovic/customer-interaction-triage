import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServiceConfig } from "../../src/config.js";
import { createRedis } from "../../src/redis.js";

let redis: Redis;

beforeAll(() => {
  redis = createRedis(loadServiceConfig().redisUrl);
});

afterAll(async () => {
  await redis.quit();
});

describe("redis", () => {
  it("answers PING", async () => {
    expect(await redis.ping()).toBe("PONG");
  });

  it("runs with append-only persistence (tech-stack.md, Queue consistency)", async () => {
    expect(await redis.config("GET", "appendonly")).toEqual(["appendonly", "yes"]);
  });
});
