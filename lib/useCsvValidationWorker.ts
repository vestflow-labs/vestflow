"use client";
import { useCallback, useEffect, useRef } from "react";
import type { CsvValidationResult } from "@/lib/csv-validation";

/** Runs CSV validation in a Web Worker so parsing 500 rows never blocks the UI thread. */
export function useCsvValidationWorker() {
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./csv-validation.worker.ts", import.meta.url));
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  return useCallback((text: string): Promise<CsvValidationResult> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error("CSV validation worker is not ready yet. Please try again."));
        return;
      }

      const handleMessage = (event: MessageEvent<CsvValidationResult>) => {
        cleanup();
        resolve(event.data);
      };
      const handleError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || "CSV validation failed."));
      };
      const cleanup = () => {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
      };

      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);
      worker.postMessage(text);
    });
  }, []);
}
