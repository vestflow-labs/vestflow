import type Redis from "ioredis";
import { parseNetwork, type NetworkName } from "./config";

export interface BalanceCacheValue {
  streamingBalance: string;
  collectableAmount: string;
  streamingRatePerSec: string;
}

export const BALANCE_CACHE_TTL_MS = 5_000;

type LocalEntry = {
  value: BalanceCacheValue;
  expiresAt: number;
};

const localCache = new Map<string, LocalEntry>();
let redisClient: Redis | null | undefined;

function defaultNetwork(): NetworkName {
  return parseNetwork(process.env.INDEXER_NETWORK);
}

export function balanceCacheKey(
  account: string,
  token: string,
  network: NetworkName = defaultNetwork(),
): string {
  return `streams:balance:${network}:${account}:${token}`;
}

function getRedisClient(): Redis | null {
  if (redisClient !== undefined) return redisClient;

  const url = process.env.REDIS_URL;
  if (!url) {
    redisClient = null;
    return redisClient;
  }

  try {
    const IORedis = require("ioredis") as typeof Redis;
    const instance = new IORedis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    instance.on("error", () => undefined);
    redisClient = instance;
  } catch {
    redisClient = null;
  }

  return redisClient;
}

function isBalanceCacheValue(value: unknown): value is BalanceCacheValue {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.streamingBalance === "string" &&
    typeof candidate.collectableAmount === "string" &&
    typeof candidate.streamingRatePerSec === "string"
  );
}

function readLocal(key: string): BalanceCacheValue | null {
  const entry = localCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    localCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeLocal(key: string, value: BalanceCacheValue): void {
  localCache.set(key, {
    value,
    expiresAt: Date.now() + BALANCE_CACHE_TTL_MS,
  });
}

export async function getOrSetBalanceCache(
  account: string,
  token: string,
  network: NetworkName,
  fetcher: () => Promise<BalanceCacheValue>,
): Promise<BalanceCacheValue> {
  const key = balanceCacheKey(account, token, network);
  const redis = getRedisClient();

  if (!redis) {
    const local = readLocal(key);
    if (local) return local;
    const value = await fetcher();
    writeLocal(key, value);
    return value;
  }

  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      const parsed: unknown = JSON.parse(cached);
      if (isBalanceCacheValue(parsed)) return parsed;
    }
  } catch {
    redisClient = null;
  }

  const value = await fetcher();
  if (redisClient === redis) {
    try {
      await redis.set(key, JSON.stringify(value), "PX", BALANCE_CACHE_TTL_MS);
    } catch {
      redisClient = null;
    }
  } else {
    writeLocal(key, value);
  }
  return value;
}

export function invalidateBalanceCache(
  account: string,
  token: string,
  network: NetworkName = defaultNetwork(),
): void {
  const key = balanceCacheKey(account, token, network);
  localCache.delete(key);

  const redis = getRedisClient();
  if (redis) {
    try {
      void redis.del(key).catch(() => undefined);
    } catch {
      redisClient = null;
    }
  }
}

export function clearBalanceCache(): void {
  localCache.clear();
}
