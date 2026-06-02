"use client";
import { useEffect, useState } from "react";

// CoinGecko free API — no key required, rate-limited to ~30 req/min
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd";

// Module-level cache so multiple hook instances share one in-flight request
let cachedPrice: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // refresh every 60 s
let inflight: Promise<number | null> | null = null;

async function fetchXlmPrice(): Promise<number | null> {
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(COINGECKO_URL, { cache: "no-store" });
      if (!res.ok) return null;
      const json = await res.json();
      const price = json?.stellar?.usd;
      if (typeof price === "number" && price > 0) {
        cachedPrice = price;
        cacheTimestamp = Date.now();
        return price;
      }
      return null;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * React hook that returns the current XLM/USD price.
 * Returns `null` while loading or if the fetch failed.
 */
export function useXlmPrice(): number | null {
  const [price, setPrice] = useState<number | null>(cachedPrice);

  useEffect(() => {
    let cancelled = false;

    const update = async () => {
      const now = Date.now();
      if (cachedPrice !== null && now - cacheTimestamp < CACHE_TTL_MS) {
        setPrice(cachedPrice);
        return;
      }
      const p = await fetchXlmPrice();
      if (!cancelled) setPrice(p);
    };

    update();

    // Re-fetch once per minute while the component is mounted
    const interval = setInterval(update, CACHE_TTL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return price;
}

/**
 * Format a USD value for display, e.g. "$1,234.56"
 * Returns an empty string when price is null (still loading / unavailable).
 */
export function formatUsd(xlmAmount: bigint | number, xlmPrice: number | null): string {
  if (xlmPrice === null) return "";
  const xlm = typeof xlmAmount === "bigint"
    ? Number(xlmAmount) / 10_000_000
    : xlmAmount;
  const usd = xlm * xlmPrice;
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
