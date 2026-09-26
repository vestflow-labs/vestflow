"use client";

import { useCallback, useEffect, useState } from "react";

const RECENTLY_VIEWED_KEY = "vestflow-recently-viewed";
const RECENTLY_VIEWED_EVENT = "vestflow-recently-viewed-updated";
const MAX_RECENTLY_VIEWED = 5;

function sanitizeRecentlyViewed(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (id): id is number => typeof id === "number" && Number.isFinite(id)
  );
}

function readRecentlyViewed(): number[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = window.localStorage.getItem(RECENTLY_VIEWED_KEY);
    if (!stored) {
      return [];
    }

    return sanitizeRecentlyViewed(JSON.parse(stored));
  } catch {
    return [];
  }
}

function writeRecentlyViewed(ids: number[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(ids));
  window.dispatchEvent(new Event(RECENTLY_VIEWED_EVENT));
}

export function useRecentlyViewed() {
  const [recentlyViewed, setRecentlyViewed] = useState<number[]>([]);

  useEffect(() => {
    const sync = () => {
      setRecentlyViewed(readRecentlyViewed());
    };

    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(RECENTLY_VIEWED_EVENT, sync);

    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(RECENTLY_VIEWED_EVENT, sync);
    };
  }, []);

  const addRecentlyViewed = useCallback((id: number) => {
    setRecentlyViewed((current) => {
      const next = [id, ...current.filter((existing) => existing !== id)].slice(
        0,
        MAX_RECENTLY_VIEWED
      );
      writeRecentlyViewed(next);
      return next;
    });
  }, []);

  return {
    recentlyViewed,
    addRecentlyViewed,
  };
}
