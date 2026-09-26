/**
 * Shared exponential backoff and retry utility
 *
 * Used by both the Horizon client and the replay engine so every outbound
 * call uses identical backoff timing and alerting behaviour.
 *
 * Schedule:
 *   attempt 0 → wait  1 s
 *   attempt 1 → wait  2 s
 *   attempt 2 → wait  4 s
 *   attempt 3 → wait  8 s
 *   attempt 4 → wait 16 s
 *   attempt 5 → wait 32 s
 *   attempt 6 → wait 64 s  (hard cap)
 *   attempt 7 → wait 64 s
 *   attempt 8 → exhausted → throw
 */

export interface RetryOptions {
  /** Maximum number of attempts (default 8, matching the spec's "max 8 retries"). */
  maxAttempts?: number;
  /** Base delay in ms for the first retry (default 1000). */
  baseDelayMs?: number;
  /** Hard ceiling on the computed delay in ms (default 64 000). */
  maxDelayMs?: number;
  /** Optional label prepended to every log line, e.g. "[horizon-client]". */
  label?: string;
  /**
   * Predicate called with the caught error before retrying.
   * Return true to allow a retry, false to rethrow immediately.
   * Default: always retry.
   */
  isRetryable?: (error: unknown, attempt: number) => boolean;
  /**
   * Callback invoked on each retry before sleeping.
   * Useful for tests to assert the number of attempts without relying on timers.
   */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
}

/**
 * Compute the delay for a given attempt index (0-based).
 *
 * @param attempt  0 = first failure (before second try)
 * @param base     base delay in ms
 * @param ceiling  hard cap in ms
 */
export function backoffDelayMs(attempt: number, base = 1000, ceiling = 64_000): number {
  return Math.min(base * Math.pow(2, attempt), ceiling);
}

/**
 * Execute `fn` with exponential backoff retries.
 *
 * ```ts
 * const result = await withRetry(
 *   () => fetch(url).then(r => r.json()),
 *   { maxAttempts: 8, label: '[horizon-client]' }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const {
    maxAttempts = 8,
    baseDelayMs = 1000,
    maxDelayMs = 64_000,
    label = '[retry]',
    isRetryable = () => true,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { value, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts - 1;

      if (isLastAttempt || !isRetryable(error, attempt)) {
        break;
      }

      const delay = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      const msg = error instanceof Error ? error.message : String(error);

      console.warn(
        `${label} attempt ${attempt + 1}/${maxAttempts} failed: ${msg}. ` +
        `Retrying in ${delay}ms…`
      );

      onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }

  // All attempts exhausted — emit the alert log the spec requires and rethrow.
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(
    `${label} ALERT: all ${maxAttempts} retry attempts exhausted. Last error: ${msg}`
  );
  throw lastError;
}

/**
 * Same as `withRetry` but returns just the value (throws on exhaustion).
 */
export async function retryOrThrow<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  return (await withRetry(fn, options)).value;
}

/** Tiny sleep helper so callers don't have to inline it. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Predicate for HTTP-level errors: don't retry 4xx (except 429).
 * Pass this as `isRetryable` when calling Horizon/RPC.
 */
export function isHttpRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const msg = error.message;
  // 4xx errors other than 429 (rate-limit) are not transient
  const match = msg.match(/HTTP (\d{3})/i) || msg.match(/status[: ]+(\d{3})/i);
  if (match) {
    const status = parseInt(match[1], 10);
    if (status >= 400 && status < 500 && status !== 429) return false;
  }
  return true;
}
