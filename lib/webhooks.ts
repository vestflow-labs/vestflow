/**
 * In-process webhook registry backing `/api/webhooks` (#443): best-effort,
 * fire-and-forget delivery with no persistence or retries.
 *
 * The production system — durable queue, HMAC handshake, exponential backoff
 * and a dead-letter queue — lives in the indexer (`indexer/src/webhook-*.ts`,
 * see indexer/README.md#webhooks). Prefer it for anything that must not
 * silently drop events.
 */

import crypto from "crypto";

export type WebhookEventType = "schedule.claimed" | "schedule.revoked" | "schedule.created";

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  events: WebhookEventType[];
  createdAt: number;
}

export interface WebhookPayload {
  event: WebhookEventType;
  scheduleId: number;
  timestamp: number;
  data: Record<string, unknown>;
}

// In-process store — survives the process lifetime; production deployments
// should swap this for a persistent database table.
const store = new Map<string, WebhookEndpoint>();

export function registerEndpoint(
  url: string,
  events: WebhookEventType[],
  secret?: string,
): WebhookEndpoint {
  const id = crypto.randomUUID();
  const endpoint: WebhookEndpoint = {
    id,
    url,
    secret: secret ?? crypto.randomBytes(32).toString("hex"),
    events,
    createdAt: Date.now(),
  };
  store.set(id, endpoint);
  return endpoint;
}

export function removeEndpoint(id: string): boolean {
  return store.delete(id);
}

export function listEndpoints(): WebhookEndpoint[] {
  return Array.from(store.values());
}

export function getEndpoint(id: string): WebhookEndpoint | undefined {
  return store.get(id);
}

function sign(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export async function deliverWebhook(
  payload: WebhookPayload,
): Promise<{ delivered: number; failed: number }> {
  const body = JSON.stringify(payload);
  let delivered = 0;
  let failed = 0;

  const matching = Array.from(store.values()).filter((ep) =>
    ep.events.includes(payload.event),
  );

  await Promise.allSettled(
    matching.map(async (ep) => {
      try {
        const sig = sign(body, ep.secret);
        const res = await fetch(ep.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-VestFlow-Signature": sig,
            "X-VestFlow-Event": payload.event,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          delivered++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }),
  );

  return { delivered, failed };
}
