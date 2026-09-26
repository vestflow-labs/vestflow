/**
 * In-memory LRU cache for GET /analytics/tvl responses.
 *
 * 100 entries, 60s TTL, keyed by `token + from + to`. Invalidation is
 * targeted: when a new ledger is indexed, only cache entries whose range
 * covers "today" are dropped — historical ranges never go stale, so
 * evicting them would just cause an avoidable thundering-herd rebuild.
 */

const MAX_ENTRIES = 100;
const TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  to: string;
}

const store = new Map<string, CacheEntry<unknown>>();

export function cacheKey(token: string, from: string, to: string, cumulative: boolean): string {
  return `${token}|${from}|${to}|${cumulative ? "1" : "0"}`;
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  // Refresh recency for LRU eviction.
  store.delete(key);
  store.set(key, entry);
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, to: string): void {
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  store.set(key, { value, expiresAt: Date.now() + TTL_MS, to });
}

/** Drop every cached range that includes today — called after each new ledger is indexed. */
export function invalidateToday(): void {
  const today = new Date().toISOString().slice(0, 10);
  for (const [key, entry] of store) {
    if (entry.to >= today) store.delete(key);
  }
}

export function cacheClear(): void {
  store.clear();
}
