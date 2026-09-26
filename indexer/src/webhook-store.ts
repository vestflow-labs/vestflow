/**
 * VestFlow Webhooks — durable state
 *
 * Every state transition of the delivery machine is committed to SQLite
 * before the HTTP request is made, so a crash or restart resumes exactly
 * where it left off: pending retries keep their `next_attempt_at`, and
 * rows left `in_flight` by a killed process are reclaimed by lease expiry.
 */

import type { NetworkName } from "./config";
import { getDb } from "./db";
import { matchesEventType } from "./webhooks";

export type DeliveryStatus =
  | "pending"
  | "in_flight"
  | "delivered"
  | "failed"
  | "dead_lettered";

export interface WebhookRegistration {
  id: string;
  owner_address: string;
  endpoint_url: string;
  secret_hash: string;
  secret_encrypted: string;
  event_types: string[];
  challenge: string | null;
  verified_at: number | null;
  disabled_at: number | null;
  created_at: number;
}

export interface WebhookDelivery {
  id: string;
  registration_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  last_status_code: number | null;
  claimed_at: number | null;
  delivered_at: number | null;
  dead_lettered_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RegistrationRow extends Omit<WebhookRegistration, "event_types"> {
  event_types: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toRegistration(row: RegistrationRow | undefined): WebhookRegistration | null {
  if (!row) return null;
  let eventTypes: string[];
  try {
    const parsed = JSON.parse(row.event_types);
    eventTypes = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    eventTypes = [];
  }
  return { ...row, event_types: eventTypes };
}

// ── Registrations ─────────────────────────────────────────────────────

export interface CreateRegistrationInput {
  id: string;
  owner_address: string;
  endpoint_url: string;
  secret_hash: string;
  secret_encrypted: string;
  event_types: string[];
  challenge: string;
}

export function createRegistration(
  input: CreateRegistrationInput,
  network?: NetworkName
): WebhookRegistration {
  const created = nowSeconds();
  getDb(network)
    .prepare(
      `INSERT INTO webhook_registrations
        (id, owner_address, endpoint_url, secret_hash, secret_encrypted,
         event_types, challenge, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.owner_address,
      input.endpoint_url,
      input.secret_hash,
      input.secret_encrypted,
      JSON.stringify(input.event_types),
      input.challenge,
      created
    );

  return {
    ...input,
    verified_at: null,
    disabled_at: null,
    created_at: created,
  };
}

export function getRegistration(
  id: string,
  network?: NetworkName
): WebhookRegistration | null {
  const row = getDb(network)
    .prepare("SELECT * FROM webhook_registrations WHERE id = ?")
    .get(id) as RegistrationRow | undefined;
  return toRegistration(row);
}

export function listRegistrationsByOwner(
  ownerAddress: string,
  network?: NetworkName
): WebhookRegistration[] {
  const rows = getDb(network)
    .prepare(
      `SELECT * FROM webhook_registrations
       WHERE owner_address = ? AND disabled_at IS NULL
       ORDER BY created_at DESC`
    )
    .all(ownerAddress) as RegistrationRow[];
  return rows.map((row) => toRegistration(row) as WebhookRegistration);
}

/**
 * Verified, enabled registrations subscribed to `eventType`.
 * Unverified endpoints are excluded here — that is what stops a rogue
 * registration from ever receiving an event.
 */
export function listRegistrationsForEvent(
  eventType: string,
  network?: NetworkName
): WebhookRegistration[] {
  const rows = getDb(network)
    .prepare(
      `SELECT * FROM webhook_registrations
       WHERE verified_at IS NOT NULL AND disabled_at IS NULL
       ORDER BY created_at ASC`
    )
    .all() as RegistrationRow[];

  return rows
    .map((row) => toRegistration(row) as WebhookRegistration)
    .filter((registration) => matchesEventType(registration.event_types, eventType));
}

/** Marks the handshake as complete and burns the challenge. */
export function markRegistrationVerified(
  id: string,
  network?: NetworkName
): boolean {
  const result = getDb(network)
    .prepare(
      `UPDATE webhook_registrations
       SET verified_at = ?, challenge = NULL
       WHERE id = ? AND verified_at IS NULL`
    )
    .run(nowSeconds(), id);
  return result.changes > 0;
}

/** Soft-delete used by DELETE /webhooks/:id — history stays queryable. */
export function disableRegistration(id: string, network?: NetworkName): boolean {
  const result = getDb(network)
    .prepare(
      `UPDATE webhook_registrations
       SET disabled_at = ?
       WHERE id = ? AND disabled_at IS NULL`
    )
    .run(nowSeconds(), id);
  return result.changes > 0;
}

/** Hard delete used when a handshake fails — nothing was ever delivered. */
export function deleteRegistration(id: string, network?: NetworkName): boolean {
  const db = getDb(network);
  const remove = db.transaction((registrationId: string) => {
    db.prepare("DELETE FROM webhook_deliveries WHERE registration_id = ?").run(
      registrationId
    );
    return db
      .prepare("DELETE FROM webhook_registrations WHERE id = ?")
      .run(registrationId).changes;
  });
  return remove(id) > 0;
}

// ── Deliveries ────────────────────────────────────────────────────────

export interface EnqueueDeliveryInput {
  id: string;
  registration_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  /** Unix seconds; defaults to now (deliver on the next worker tick). */
  next_attempt_at?: number;
}

/**
 * Queues one delivery. Idempotent: re-indexing the same event for the same
 * registration is ignored thanks to the deterministic delivery ID and the
 * UNIQUE (registration_id, event_id) constraint.
 *
 * Returns true when a new row was created.
 */
export function enqueueDelivery(
  input: EnqueueDeliveryInput,
  network?: NetworkName
): boolean {
  const now = nowSeconds();
  const result = getDb(network)
    .prepare(
      `INSERT OR IGNORE INTO webhook_deliveries
        (id, registration_id, event_id, event_type, payload, status,
         attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
    )
    .run(
      input.id,
      input.registration_id,
      input.event_id,
      input.event_type,
      input.payload,
      input.next_attempt_at ?? now,
      now,
      now
    );
  return result.changes > 0;
}

/**
 * Atomically leases up to `limit` due deliveries by flipping them to
 * `in_flight`. The UPDATE ... RETURNING runs in a single implicit
 * transaction, so two workers can never claim the same row.
 */
export function claimDueDeliveries(
  limit: number,
  at: number = nowSeconds(),
  network?: NetworkName
): WebhookDelivery[] {
  if (limit <= 0) return [];
  return getDb(network)
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'in_flight', claimed_at = ?, updated_at = ?
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT ?
       )
       RETURNING *`
    )
    .all(at, at, at, limit) as WebhookDelivery[];
}

/**
 * Returns deliveries stranded in `in_flight` by a crashed worker to the
 * pending queue so no delivery is ever stuck.
 */
export function reclaimStaleDeliveries(
  leaseSeconds: number,
  at: number = nowSeconds(),
  network?: NetworkName
): number {
  const result = getDb(network)
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'pending', claimed_at = NULL, next_attempt_at = ?, updated_at = ?
       WHERE status = 'in_flight' AND claimed_at IS NOT NULL AND claimed_at <= ?`
    )
    .run(at, at, at - leaseSeconds);
  return result.changes;
}

export function markDelivered(
  id: string,
  statusCode: number,
  at: number = nowSeconds(),
  network?: NetworkName
): boolean {
  const result = getDb(network)
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'delivered', delivered_at = ?, last_status_code = ?,
           last_error = NULL, attempt_count = attempt_count + 1,
           claimed_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'in_flight'`
    )
    .run(at, statusCode, at, id);
  return result.changes > 0;
}

export interface FailureInput {
  id: string;
  error: string;
  statusCode: number | null;
  nextAttemptAt: number;
  at?: number;
}

/** Records a retryable failure and schedules the next attempt. */
export function scheduleRetry(
  input: FailureInput,
  network?: NetworkName
): boolean {
  const at = input.at ?? nowSeconds();
  const result = getDb(network)
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'pending', attempt_count = attempt_count + 1,
           next_attempt_at = ?, last_error = ?, last_status_code = ?,
           claimed_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'in_flight'`
    )
    .run(input.nextAttemptAt, input.error, input.statusCode, at, input.id);
  return result.changes > 0;
}

/** Terminal state after the final attempt — never retried automatically. */
export function markDeadLettered(
  id: string,
  error: string,
  statusCode: number | null,
  at: number = nowSeconds(),
  network?: NetworkName
): boolean {
  const result = getDb(network)
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'dead_lettered', attempt_count = attempt_count + 1,
           dead_lettered_at = ?, last_error = ?, last_status_code = ?,
           claimed_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'in_flight'`
    )
    .run(at, error, statusCode, at, id);
  return result.changes > 0;
}

/**
 * Terminal failure that is not worth retrying (the registration vanished,
 * was disabled, or the endpoint answered 410 Gone).
 */
export function markFailed(
  id: string,
  error: string,
  statusCode: number | null,
  at: number = nowSeconds(),
  network?: NetworkName
): boolean {
  const result = getDb(network)
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'failed', last_error = ?, last_status_code = ?,
           claimed_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'in_flight'`
    )
    .run(error, statusCode, at, id);
  return result.changes > 0;
}

/** Manual retry of a dead-lettered delivery: same ID, fresh attempt budget. */
export function requeueDelivery(
  id: string,
  at: number = nowSeconds(),
  network?: NetworkName
): boolean {
  const result = getDb(network)
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'pending', attempt_count = 0, next_attempt_at = ?,
           dead_lettered_at = NULL, last_error = NULL, claimed_at = NULL,
           updated_at = ?
       WHERE id = ? AND status IN ('dead_lettered', 'failed')`
    )
    .run(at, at, id);
  return result.changes > 0;
}

export function getDelivery(
  id: string,
  network?: NetworkName
): WebhookDelivery | null {
  const row = getDb(network)
    .prepare("SELECT * FROM webhook_deliveries WHERE id = ?")
    .get(id) as WebhookDelivery | undefined;
  return row ?? null;
}

export interface ListDeliveriesParams {
  registrationId: string;
  status?: DeliveryStatus;
  limit?: number;
  offset?: number;
}

export function listDeliveries(
  params: ListDeliveriesParams,
  network?: NetworkName
): WebhookDelivery[] {
  const conditions = ["registration_id = ?"];
  const values: unknown[] = [params.registrationId];

  if (params.status) {
    conditions.push("status = ?");
    values.push(params.status);
  }

  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);

  return getDb(network)
    .prepare(
      `SELECT * FROM webhook_deliveries
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as WebhookDelivery[];
}

/** Aggregate counts per status — used by the load test and /webhooks/stats. */
export function countDeliveriesByStatus(
  network?: NetworkName
): Record<DeliveryStatus, number> {
  const rows = getDb(network)
    .prepare("SELECT status, COUNT(*) AS count FROM webhook_deliveries GROUP BY status")
    .all() as { status: DeliveryStatus; count: number }[];

  const counts: Record<DeliveryStatus, number> = {
    pending: 0,
    in_flight: 0,
    delivered: 0,
    failed: 0,
    dead_lettered: 0,
  };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}
