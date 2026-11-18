import { Redis } from "ioredis";

// ioredis is the client BullMQ (P08) is built on, so the project uses one Redis client.
// BullMQ needs `maxRetriesPerRequest: null` on the connections it uses for workers.
export function createRedis(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
