/**
 * VestFlow Webhooks — delivery worker
 *
 * A bounded pool of concurrent senders drains the durable delivery queue:
 *
 *   pending ──claim──▶ in_flight ──2xx──▶ delivered
 *                          │
 *                          ├─ retryable failure ─▶ pending (next_attempt_at = now + 2^(n-1)s)
 *                          ├─ attempt 10 failed ─▶ dead_lettered
 *                          └─ permanent failure ─▶ failed
 *
 * Fan-out (`fanOutEvent`) only writes rows — it never performs I/O — so the
 * indexer's polling loop is never blocked on a subscriber's HTTP response.
 */

import type { NetworkName } from "./config";
import {
  claimDueDeliveries,
  deleteRegistration,
  enqueueDelivery,
  getRegistration,
  listRegistrationsForEvent,
  markDeadLettered,
  markDelivered,
  markFailed,
  markRegistrationVerified,
  reclaimStaleDeliveries,
  scheduleRetry,
  type WebhookDelivery,
  type WebhookRegistration,
} from "./webhook-store";
import {
  assertDeliverableUrl,
  backoffDelaySeconds,
  computeSignature,
  DEFAULT_BACKOFF_BASE_MS,
  decryptSecret,
  deliveryIdFor,
  getEncryptionKey,
  MAX_ATTEMPTS,
  parseSignatureHeader,
  REQUEST_TIMEOUT_MS,
  signPayload,
  timingSafeEqualHex,
  type WebhookEventPayload,
} from "./webhooks";

/** Minimal shape of the parts of `fetch` this worker relies on. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface WorkerOptions {
  /** Concurrent in-flight HTTP requests (default 10). */
  concurrency?: number;
  /** Queue poll interval in ms (default 1000). */
  pollIntervalMs?: number;
  /** Per-request timeout in ms (default 10000). */
  requestTimeoutMs?: number;
  /** Backoff time unit in ms (default 1000); compressed by the load test. */
  backoffBaseMs?: number;
  /**
   * How long an in_flight lease may go unfinished before another worker
   * reclaims it (default 120s).
   */
  leaseSeconds?: number;
  network?: NetworkName;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
  /** Injectable HTTP client. */
  fetchImpl?: FetchLike;
  /** AES key override; defaults to WEBHOOK_ENCRYPTION_KEY. */
  encryptionKey?: Buffer;
  onError?: (message: string, error: unknown) => void;
}

export interface DeliveryOutcome {
  id: string;
  status: "delivered" | "pending" | "dead_lettered" | "failed";
  statusCode: number | null;
  error?: string;
}

const DEFAULT_CONCURRENCY = Number(process.env.WEBHOOK_CONCURRENCY ?? "10");
const DEFAULT_POLL_INTERVAL_MS = Number(
  process.env.WEBHOOK_POLL_INTERVAL_MS ?? "1000"
);
const DEFAULT_LEASE_SECONDS = Number(process.env.WEBHOOK_LEASE_SECONDS ?? "120");

function defaultFetch(): FetchLike {
  return globalThis.fetch as unknown as FetchLike;
}

export class WebhookDeliveryWorker {
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly leaseSeconds: number;

  private readonly network?: NetworkName;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private readonly encryptionKey: Buffer | null;
  private readonly onError: (message: string, error: unknown) => void;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private wakeUp: (() => void) | null = null;

  constructor(options: WorkerOptions = {}) {
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.network = options.network;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? defaultFetch();
    this.encryptionKey = options.encryptionKey ?? null;
    this.onError =
      options.onError ??
      ((message, error) => console.error(`[webhooks] ${message}`, error));
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private key(): Buffer {
    return this.encryptionKey ?? getEncryptionKey();
  }

  /** Number of deliveries currently being sent. */
  get activeCount(): number {
    return this.inFlight.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    setActiveWorker(this);
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (activeWorker === this) setActiveWorker(null);
    this.wake();
    await this.loopPromise?.catch(() => undefined);
    await Promise.allSettled([...this.inFlight]);
    this.loopPromise = null;
  }

  /** Interrupts the poll sleep so a freshly enqueued delivery goes out now. */
  wake(): void {
    this.wakeUp?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      // Do not hold the event loop open purely for the poll timer.
      if (typeof timer.unref === "function") timer.unref();
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let saturated = false;
      try {
        reclaimStaleDeliveries(this.leaseSeconds, this.nowSeconds(), this.network);
        const capacity = this.availableSlots();
        const claimed = this.dispatchDue();
        // A full batch means more work is very likely waiting: wait for a
        // free slot instead of paying the poll interval.
        saturated = capacity > 0 && claimed === capacity;
      } catch (error) {
        this.onError("delivery loop error", error);
      }

      if (saturated && this.inFlight.size > 0) {
        await Promise.race([...this.inFlight]);
        continue;
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private availableSlots(): number {
    return Math.max(this.concurrency - this.inFlight.size, 0);
  }

  /** Claims and starts up to the remaining concurrency budget. */
  private dispatchDue(): number {
    const capacity = this.availableSlots();
    if (capacity === 0) return 0;

    const batch = claimDueDeliveries(capacity, this.nowSeconds(), this.network);
    for (const delivery of batch) {
      const task = this.attemptDelivery(delivery)
        .catch((error) => this.onError(`delivery ${delivery.id} crashed`, error))
        .then(() => {
          this.inFlight.delete(task);
        });
      this.inFlight.add(task);
    }
    return batch.length;
  }

  /**
   * Runs a single drain pass and waits for it to finish.
   * Used by tests and the load runner to step the queue deterministically.
   */
  async runOnce(): Promise<number> {
    reclaimStaleDeliveries(this.leaseSeconds, this.nowSeconds(), this.network);
    let total = 0;

    for (;;) {
      const claimed = this.dispatchDue();
      total += claimed;

      if (this.inFlight.size > 0) {
        // Refill as soon as a single slot frees rather than waiting for the
        // whole batch — keeps the pool saturated on large queues.
        await Promise.race([...this.inFlight]);
        continue;
      }
      // Nothing running and nothing claimable: the queue is drained.
      if (claimed === 0) break;
    }

    return total;
  }

  /** Sends one already-claimed (`in_flight`) delivery and records the result. */
  async attemptDelivery(delivery: WebhookDelivery): Promise<DeliveryOutcome> {
    const registration = getRegistration(delivery.registration_id, this.network);

    if (!registration || registration.disabled_at || !registration.verified_at) {
      const reason = registration
        ? "registration is disabled or unverified"
        : "registration no longer exists";
      markFailed(delivery.id, reason, null, this.nowSeconds(), this.network);
      return { id: delivery.id, status: "failed", statusCode: null, error: reason };
    }

    let secret: string;
    try {
      secret = decryptSecret(registration.secret_encrypted, this.key());
    } catch (error) {
      const reason = `secret could not be decrypted: ${errorMessage(error)}`;
      markFailed(delivery.id, reason, null, this.nowSeconds(), this.network);
      return { id: delivery.id, status: "failed", statusCode: null, error: reason };
    }

    const timestamp = this.nowSeconds();
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "VestFlow-Webhooks/1.0",
      "X-VestFlow-Delivery-ID": delivery.id,
      "X-VestFlow-Event": delivery.event_type,
      "X-VestFlow-Event-ID": delivery.event_id,
      "X-VestFlow-Attempt": String(delivery.attempt_count + 1),
      "X-VestFlow-Signature": signPayload(secret, delivery.payload, timestamp),
    };

    try {
      const response = await this.request(
        registration.endpoint_url,
        headers,
        delivery.payload
      );

      if (response.ok) {
        markDelivered(delivery.id, response.status, this.nowSeconds(), this.network);
        return { id: delivery.id, status: "delivered", statusCode: response.status };
      }

      // 410 Gone is the receiver telling us to stop: terminal, not a retry.
      if (response.status === 410) {
        const reason = "endpoint responded 410 Gone";
        markFailed(delivery.id, reason, 410, this.nowSeconds(), this.network);
        return { id: delivery.id, status: "failed", statusCode: 410, error: reason };
      }

      return this.recordFailure(
        delivery,
        `endpoint responded ${response.status}`,
        response.status
      );
    } catch (error) {
      return this.recordFailure(delivery, errorMessage(error), null);
    }
  }

  private recordFailure(
    delivery: WebhookDelivery,
    error: string,
    statusCode: number | null
  ): DeliveryOutcome {
    const attempts = delivery.attempt_count + 1;
    const at = this.nowSeconds();

    if (attempts >= MAX_ATTEMPTS) {
      markDeadLettered(delivery.id, error, statusCode, at, this.network);
      return { id: delivery.id, status: "dead_lettered", statusCode, error };
    }

    const delaySeconds = Math.round(
      (backoffDelaySeconds(attempts) * this.backoffBaseMs) / 1000
    );
    scheduleRetry(
      {
        id: delivery.id,
        error,
        statusCode,
        nextAttemptAt: at + delaySeconds,
        at,
      },
      this.network
    );
    return { id: delivery.id, status: "pending", statusCode, error };
  }

  private async request(
    url: string,
    headers: Record<string, string>,
    body: string
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Handshake: POST the challenge signed with the shared secret and require
   * the endpoint to echo the exact same signature within the timeout.
   * Only an operator who holds the secret can produce it, which is what
   * stops an attacker from pointing VestFlow at someone else's service.
   *
   * Per spec, a failed handshake deletes the registration.
   */
  async verifyRegistration(
    registrationId: string
  ): Promise<{ verified: boolean; error?: string }> {
    const registration = getRegistration(registrationId, this.network);
    if (!registration) return { verified: false, error: "registration not found" };
    if (registration.verified_at) return { verified: true };
    if (!registration.challenge) {
      return { verified: false, error: "registration has no pending challenge" };
    }

    const failed = (error: string) => {
      deleteRegistration(registrationId, this.network);
      return { verified: false, error };
    };

    try {
      await assertDeliverableUrl(registration.endpoint_url);
    } catch (error) {
      return failed(errorMessage(error));
    }

    let secret: string;
    try {
      secret = decryptSecret(registration.secret_encrypted, this.key());
    } catch (error) {
      return failed(`secret could not be decrypted: ${errorMessage(error)}`);
    }

    const body = JSON.stringify({
      type: "webhook.handshake",
      registration_id: registration.id,
      challenge: registration.challenge,
    });
    const timestamp = this.nowSeconds();
    const expected = computeSignature(secret, body, timestamp);

    try {
      const response = await this.request(registration.endpoint_url, {
        "Content-Type": "application/json",
        "User-Agent": "VestFlow-Webhooks/1.0",
        "X-VestFlow-Event": "webhook.handshake",
        "X-VestFlow-Signature": `t=${timestamp},v1=${expected}`,
      }, body);

      if (response.status !== 200) {
        return failed(`handshake responded ${response.status}, expected 200`);
      }

      const echoed = await readEchoedSignature(response);
      if (!echoed) {
        return failed("handshake response did not echo X-VestFlow-Signature");
      }
      if (echoed.timestamp !== timestamp || !timingSafeEqualHex(echoed.signature, expected)) {
        return failed("handshake signature mismatch — endpoint does not hold the secret");
      }
    } catch (error) {
      return failed(`handshake request failed: ${errorMessage(error)}`);
    }

    markRegistrationVerified(registration.id, this.network);
    return { verified: true };
  }

  /**
   * Sends a signed `webhook.test` event to a registration's endpoint and
   * reports whether it answered 2xx. Nothing is queued or retried, so a test
   * never appears in the registration's delivery history.
   */
  async sendTestEvent(
    registration: WebhookRegistration
  ): Promise<{ success: boolean; status: number | null; error?: string }> {
    let secret: string;
    try {
      await assertDeliverableUrl(registration.endpoint_url);
      secret = decryptSecret(registration.secret_encrypted, this.key());
    } catch (error) {
      return { success: false, status: null, error: errorMessage(error) };
    }

    const body = JSON.stringify({
      type: "webhook.test",
      registration_id: registration.id,
    });

    try {
      const response = await this.request(registration.endpoint_url, {
        "Content-Type": "application/json",
        "User-Agent": "VestFlow-Webhooks/1.0",
        "X-VestFlow-Event": "webhook.test",
        "X-VestFlow-Signature": signPayload(secret, body, this.nowSeconds()),
      }, body);

      if (response.ok) return { success: true, status: response.status };
      return {
        success: false,
        status: response.status,
        error: `endpoint responded ${response.status}`,
      };
    } catch (error) {
      return { success: false, status: null, error: errorMessage(error) };
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return String(error);
}

/** Accepts the echo in the response header or in a JSON `signature` field. */
async function readEchoedSignature(
  response: Awaited<ReturnType<FetchLike>>
): Promise<{ timestamp: number; signature: string } | null> {
  const header = response.headers.get("x-vestflow-signature");
  if (header) return parseSignatureHeader(header);

  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as { signature?: unknown };
    if (typeof parsed.signature === "string") {
      return parseSignatureHeader(parsed.signature);
    }
  } catch {
    return parseSignatureHeader(text.trim());
  }
  return null;
}

// ── Fan-out ───────────────────────────────────────────────────────────

/** Set while a worker is running so fan-out can wake it immediately. */
let activeWorker: WebhookDeliveryWorker | null = null;

function setActiveWorker(worker: WebhookDeliveryWorker | null): void {
  activeWorker = worker;
}

export function getActiveWorker(): WebhookDeliveryWorker | null {
  return activeWorker;
}

/**
 * Queues one delivery row per subscribed, verified endpoint.
 *
 * Synchronous and I/O-free: the caller (the poller) returns to indexing
 * immediately while the worker pool performs the HTTP requests.
 * Returns the number of deliveries newly queued.
 */
export function fanOutEvent(
  payload: WebhookEventPayload,
  network?: NetworkName
): number {
  const registrations = listRegistrationsForEvent(payload.event_type, network);
  if (registrations.length === 0) return 0;

  const body = JSON.stringify(payload);
  let queued = 0;

  for (const registration of registrations) {
    const created = enqueueDelivery(
      {
        id: deliveryIdFor(registration.id, payload.event_id),
        registration_id: registration.id,
        event_id: payload.event_id,
        event_type: String(payload.event_type),
        payload: body,
      },
      network
    );
    if (created) queued++;
  }

  if (queued > 0) activeWorker?.wake();
  return queued;
}

/** Re-exported for callers that need the registration shape. */
export type { WebhookRegistration };
