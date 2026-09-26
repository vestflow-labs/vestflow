"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  computeClaimableForCursor,
  type ClaimableResponse,
  type ClaimableResult,
} from "@/lib/portfolio/claimable";
import type { TimelineSchedule } from "@/lib/portfolio/types";

/**
 * Drives the claimable-calculator Web Worker.
 *
 * The hook owns the worker's lifetime, keeps the worker's cached schedule set
 * in sync, and hands results back through a callback rather than React state —
 * the canvas consumes them by marking itself dirty, so pushing them through a
 * re-render would only add work to a 60 fps drag.
 *
 * Where a worker cannot be constructed (server render, jsdom, a browser that
 * refuses the module worker) the same pure math runs synchronously on the main
 * thread. Results are identical; only the scheduling differs.
 */
/**
 * Public URL of the bundled worker.
 *
 * The script is produced from `workers/claimable-calculator.worker.ts` by
 * `npm run worker:build` (wired into `prebuild` and `predev`) and served from
 * the app's own origin, which keeps it within the site's `default-src 'self'`
 * content security policy.
 */
const WORKER_URL = "/workers/claimable-calculator.worker.js";

export interface ClaimableWorkerApi {
  /** Recompute every schedule's claimable amount at `ledger`. */
  requestCursor: (ledger: number) => void;
}

export function useClaimableWorker(
  schedules: readonly TimelineSchedule[],
  onResults: (results: ClaimableResult[], cursorLedger: number) => void
): ClaimableWorkerApi {
  const workerRef = useRef<Worker | null>(null);

  // Held in refs so a changing callback never tears down the worker mid-drag.
  const onResultsRef = useRef(onResults);
  const schedulesRef = useRef(schedules);
  const lastCursorRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const latestAppliedRef = useRef(-1);

  useLayoutEffect(() => {
    onResultsRef.current = onResults;
    schedulesRef.current = schedules;
  });

  useEffect(() => {
    if (typeof Worker === "undefined") return;

    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL);
    } catch {
      // No worker available — requestCursor falls back to the main thread.
      return;
    }

    worker.onmessage = (event: MessageEvent<ClaimableResponse>) => {
      const data = event.data;
      if (!data || !Array.isArray(data.results)) return;
      // Drop responses for cursor positions the pointer has already moved past.
      const id = data.requestId ?? 0;
      if (id < latestAppliedRef.current) return;
      latestAppliedRef.current = id;
      onResultsRef.current(data.results, data.cursorLedger);
    };
    worker.onerror = () => {
      // A worker that fails to load or throws should degrade to the main
      // thread, not leave the timeline without claimable values.
      worker.terminate();
      workerRef.current = null;
      const cursor = lastCursorRef.current;
      if (cursor !== null) {
        onResultsRef.current(
          computeClaimableForCursor(schedulesRef.current, cursor),
          cursor
        );
      }
    };

    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Push the schedule set whenever it changes, so later cursor messages can
  // carry nothing but a number.
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    worker.postMessage({
      cursorLedger: lastCursorRef.current ?? Math.floor(Date.now() / 1000),
      schedules: schedules as TimelineSchedule[],
      requestId: ++requestIdRef.current,
    });
  }, [schedules]);

  const requestCursor = useCallback((ledger: number) => {
    lastCursorRef.current = ledger;
    const worker = workerRef.current;
    if (worker) {
      worker.postMessage({ cursorLedger: ledger, requestId: ++requestIdRef.current });
      return;
    }
    onResultsRef.current(computeClaimableForCursor(schedulesRef.current, ledger), ledger);
  }, []);

  return { requestCursor };
}
