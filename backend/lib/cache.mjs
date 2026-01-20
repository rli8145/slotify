import { Redis } from "ioredis";
import { createHash } from "node:crypto";

// Deliberately a separate connection from the one in lib/redis.mjs. That
// connection sets maxRetriesPerRequest: null because BullMQ requires it —
// which also means a plain GET/SET on it would retry forever (i.e. hang the
// request) if Redis were ever unreachable. Caching should fail *open*
// instead: a short retry budget and command timeout so an outage just falls
// through to the live OpenAI/ElevenLabs call rather than blocking it.
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const cacheConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  commandTimeout: 2000,
  lazyConnect: true,
});

let warned = false;
cacheConnection.on("error", (error) => {
  // Same throttling rationale as lib/redis.mjs: don't flood the console.
  if (!warned) {
    warned = true;
    console.warn(
      `[cache] Redis unavailable at ${redisUrl} (${error.code ?? error.message}); continuing without caching.`,
    );
  }
});

export const cacheKey = (namespace, parts) => {
  const hash = createHash("sha1").update(JSON.stringify(parts)).digest("hex");
  return `cache:${namespace}:${hash}`;
};

/**
 * Binary-safe get. Returns null on a miss OR on any Redis failure — callers
 * should always be able to treat null as "go compute it live."
 */
export const cacheGetBuffer = async (key) => {
  try {
    return await cacheConnection.getBuffer(key);
  } catch (error) {
    console.warn(`[cache] read failed for ${key}:`, error.message ?? error);
    return null;
  }
};

export const cacheSetBuffer = async (key, buffer, ttlSeconds) => {
  try {
    await cacheConnection.set(key, buffer, "EX", ttlSeconds);
  } catch (error) {
    console.warn(`[cache] write failed for ${key}:`, error.message ?? error);
  }
};

export const cacheGetText = async (key) => {
  const buffer = await cacheGetBuffer(key);
  return buffer ? buffer.toString("utf8") : null;
};

export const cacheSetText = async (key, text, ttlSeconds) => {
  await cacheSetBuffer(key, Buffer.from(text, "utf8"), ttlSeconds);
};
