/**
 * Server-only read-through Redis cache for contract state reads (schedule
 * data, claimable amounts). Reduces Horizon/RPC load from repeat visitors
 * hitting the same schedule within a short window (#206).
 *
 * This module is imported only from `app/api/**\/route.ts` handlers, never
 * from `lib/stellar.ts` (which is also imported by client components) — an
 * ioredis import in a client bundle would break the browser build, since
 * ioredis depends on Node's `net`/`tls` sockets.
 *
 * Fails open: if `REDIS_URL` isn't configured, or Redis is unreachable, the
 * cache is skipped entirely and the fetcher runs directly. There is no
 * Redis instance available in this environment/CI, so this path (no
 * REDIS_URL set) is what's actually exercised.
 */
import type Redis from "ioredis";

let client: Redis | null | undefined;

function getClient(): Redis | null {
  if (client !== undefined) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    client = null;
    return client;
  }

  try {
    // Lazily required so environments without REDIS_URL never even load
    // the ioredis module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis") as typeof Redis;
    const instance = new IORedis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // don't keep retrying a dead connection
    });
    instance.on("error", (err) => {
      console.error("[redisCache] connection error, falling back to direct reads:", err.message);
    });
    client = instance;
  } catch (err) {
    console.error("[redisCache] failed to initialize, falling back to direct reads:", err);
    client = null;
  }

  return client;
}

/**
 * Read `key` from Redis; on miss (or if Redis is unavailable), call
 * `fetcher()`, cache its result for `ttlSeconds`, and return it. Any Redis
 * failure at any step falls open to `fetcher()` directly rather than
 * failing the request.
 */
// Schedule/claimable data (ScheduleData, bigint amounts) doesn't survive
// plain JSON.stringify/parse — BigInt throws on stringify, and there's no
// way to tell a stringified number apart from a stringified bigint on the
// way back in. Tag bigints on the way out, untag them on the way in.
const BIGINT_TAG = "__bigint__:";

function bigintSafeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? `${BIGINT_TAG}${v.toString()}` : v,
  );
}

function bigintSafeParse<T>(raw: string): T {
  return JSON.parse(raw, (_key, v) =>
    typeof v === "string" && v.startsWith(BIGINT_TAG)
      ? BigInt(v.slice(BIGINT_TAG.length))
      : v,
  ) as T;
}

export async function getOrSetCache<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const redis = getClient();
  if (!redis) return fetcher();

  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      return bigintSafeParse<T>(cached);
    }
  } catch (err) {
    console.error(`[redisCache] read failed for key=${key}, falling back to direct read:`, err);
    return fetcher();
  }

  const value = await fetcher();

  try {
    await redis.set(key, bigintSafeStringify(value), "EX", ttlSeconds);
  } catch (err) {
    // Cache write failure shouldn't fail the request — the caller already
    // has a valid value from fetcher().
    console.error(`[redisCache] write failed for key=${key}:`, err);
  }

  return value;
}
