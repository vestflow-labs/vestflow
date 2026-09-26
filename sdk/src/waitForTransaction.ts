// ===========================================================================
// VestFlow SDK — waitForTransaction helper
// Issue #684: exponential-backoff transaction poller
//
// A standalone, dependency-light helper that polls a Soroban RPC endpoint for a
// submitted transaction until it reaches a terminal status, backing off
// exponentially between polls (1s, 2s, 4s, 8s, ...).
// ===========================================================================

import type { rpc as StellarRpc } from "@stellar/stellar-sdk";

export type GetTransactionResponse = StellarRpc.Api.GetTransactionResponse;

/**
 * Error thrown when {@link waitForTransaction} exceeds its timeout while the
 * transaction is still unconfirmed (`NOT_FOUND`).
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * A function that fetches the current state of a transaction from the RPC.
 * Typically `server.getTransaction.bind(server)` from `@stellar/stellar-sdk`.
 */
export type GetTransactionFn = (
  hash: string
) => Promise<GetTransactionResponse>;

export interface WaitForTransactionOptions {
  /** Maximum total time to wait before giving up. Defaults to 30s. */
  timeoutMs?: number;
  /** Delay before the first retry poll. Defaults to 1000ms (the backoff base). */
  initialDelayMs?: number;
  /** Upper bound on the backoff delay. Defaults to 8000ms. */
  maxDelayMs?: number;
  /**
   * Injectable transport. Defaults to throwing — callers should pass
   * `server.getTransaction.bind(server)` from a configured `StellarRpc.Server`.
   */
  getTransaction?: GetTransactionFn;
}

/**
 * Poll a Soroban RPC for a submitted transaction until it settles.
 *
 * The poll loop uses exponential backoff: after the first `NOT_FOUND` response
 * it waits `initialDelayMs`, then doubles the delay each round up to
 * `maxDelayMs` (1s → 2s → 4s → 8s → ...). This avoids hammering the RPC while
 * still resolving quickly for fast-confirming transactions.
 *
 * @param hash - Transaction hash returned by `sendTransaction`.
 * @param options - Optional timeout / backoff tuning, or an injected transport.
 * @returns The settled transaction response on success.
 * @throws {TimeoutError} If the transaction is still `NOT_FOUND` after `timeoutMs`.
 * @throws {Error} If the transaction reaches a terminal `FAILED` or `ERROR` status.
 */
export async function waitForTransaction(
  hash: string,
  options: WaitForTransactionOptions = {}
): Promise<GetTransactionResponse> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const getTransaction =
    options.getTransaction ??
    (() => {
      throw new Error(
        "waitForTransaction requires a `getTransaction` transport (e.g. server.getTransaction.bind(server))"
      );
    });

  const deadline = Date.now() + timeoutMs;
  let delay = initialDelayMs;

  const status = await getTransaction(hash);
  if ((status.status as string) === "SUCCESS") return status;
  if ((status.status as string) === "FAILED" || (status.status as string) === "ERROR") {
    throw new Error(
      `Transaction ${hash} ${(status.status as string).toLowerCase()}: ${
        (status as { error?: string }).error ?? "unknown error"
      }`
    );
  }

  while (true) {
    if (Date.now() >= deadline) {
      throw new TimeoutError(
        `Timed out waiting for transaction ${hash} to confirm after ${timeoutMs}ms`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, maxDelayMs);

    const next = await getTransaction(hash);
    if ((next.status as string) === "SUCCESS") return next;
    if ((next.status as string) === "FAILED" || (next.status as string) === "ERROR") {
      throw new Error(
        `Transaction ${hash} ${(next.status as string).toLowerCase()}: ${
          (next as { error?: string }).error ?? "unknown error"
        }`
      );
    }
  }
}
