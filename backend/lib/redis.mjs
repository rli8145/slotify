import { Redis } from "ioredis";

// Shared Redis connection used by both the API process (to enqueue jobs /
// read status) and the worker process (to consume jobs). BullMQ requires
// maxRetriesPerRequest: null on connections handed to a Worker/QueueEvents.
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
});

let lastErrorLoggedAt = 0;
redisConnection.on("error", (error) => {
  // Redis is expected to be briefly unavailable during local dev / compose
  // startup ordering; throttle so it doesn't flood the console with a retry
  // every few hundred ms.
  const now = Date.now();
  if (now - lastErrorLoggedAt > 5000) {
    lastErrorLoggedAt = now;
    console.error(
      `[redis] not reachable at ${redisUrl} (${error.code ?? error.message ?? "unknown error"}); retrying...`,
    );
  }
});

redisConnection.on("connect", () => {
  console.log(`[redis] connected to ${redisUrl}`);
});
