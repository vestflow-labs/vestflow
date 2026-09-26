/**
 * VestFlow Webhooks — management API
 *
 * Mounted on the indexer query server:
 *
 *   POST   /webhooks                                     register an endpoint
 *   GET    /webhooks                                     list your registrations
 *   POST   /webhooks/test                                send a test event to a registered endpoint
 *   GET    /webhooks/:id                                 registration detail
 *   POST   /webhooks/:id/verify                          (re)run the handshake
 *   DELETE /webhooks/:id                                 disable a registration
 *   GET    /webhooks/:id/deliveries?status=&limit=       delivery history
 *   POST   /webhooks/:id/deliveries/:delivery_id/retry   requeue a dead letter
 *
 * All routes require `Authorization: Bearer <wallet JWT>`; a registration is
 * only visible to the wallet address that created it.
 */

import crypto from "crypto";
import type http from "http";
import { extractBearerToken, verifyAuthToken } from "./auth";
import type { NetworkName } from "./config";
import { WebhookDeliveryWorker, getActiveWorker } from "./webhook-delivery";
import {
  createRegistration,
  disableRegistration,
  getDelivery,
  getRegistration,
  listDeliveries,
  listRegistrationsByOwner,
  requeueDelivery,
  type DeliveryStatus,
  type WebhookDelivery,
  type WebhookRegistration,
} from "./webhook-store";
import {
  assertDeliverableUrl,
  encryptSecret,
  generateChallenge,
  generateSecret,
  hashSecret,
  normalizeEventTypes,
} from "./webhooks";

const MAX_BODY_BYTES = 64 * 1024;

const DELIVERY_STATUSES: DeliveryStatus[] = [
  "pending",
  "in_flight",
  "delivered",
  "failed",
  "dead_lettered",
];

export interface WebhookApiOptions {
  network?: NetworkName;
  /** Worker used to run handshakes and test events; defaults to the running poller worker. */
  worker?: WebhookDeliveryWorker;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }

  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Public projection — never leaks the stored secret material. */
function publicRegistration(registration: WebhookRegistration) {
  return {
    id: registration.id,
    owner_address: registration.owner_address,
    endpoint_url: registration.endpoint_url,
    event_types: registration.event_types,
    verified: registration.verified_at != null,
    verified_at: registration.verified_at,
    disabled_at: registration.disabled_at,
    created_at: registration.created_at,
  };
}

function publicDelivery(delivery: WebhookDelivery) {
  let payload: unknown = delivery.payload;
  try {
    payload = JSON.parse(delivery.payload);
  } catch {
    // Keep the raw string if it somehow is not valid JSON.
  }
  return {
    id: delivery.id,
    registration_id: delivery.registration_id,
    event_id: delivery.event_id,
    event_type: delivery.event_type,
    status: delivery.status,
    attempt_count: delivery.attempt_count,
    next_attempt_at: delivery.next_attempt_at,
    last_error: delivery.last_error,
    last_status_code: delivery.last_status_code,
    delivered_at: delivery.delivered_at,
    dead_lettered_at: delivery.dead_lettered_at,
    created_at: delivery.created_at,
    payload,
  };
}

function authenticate(
  req: http.IncomingMessage,
  res: http.ServerResponse
): string | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    json(res, 503, {
      error: "JWT_SECRET is not configured — webhook management is disabled",
    });
    return null;
  }

  const token = extractBearerToken(req.headers.authorization);
  const payload = token ? verifyAuthToken(token, secret) : null;
  if (!payload) {
    json(res, 401, { error: "Missing or invalid bearer token" });
    return null;
  }
  return payload.sub;
}

/**
 * Loads a registration and enforces ownership. Responds 404 for both
 * "missing" and "not yours" so registration IDs cannot be enumerated.
 */
function requireOwnedRegistration(
  res: http.ServerResponse,
  id: string,
  owner: string,
  network?: NetworkName
): WebhookRegistration | null {
  const registration = getRegistration(id, network);
  if (!registration || registration.owner_address !== owner) {
    json(res, 404, { error: "Webhook registration not found" });
    return null;
  }
  return registration;
}

function verifier(options: WebhookApiOptions): WebhookDeliveryWorker {
  return (
    options.worker ??
    getActiveWorker() ??
    new WebhookDeliveryWorker({ network: options.network })
  );
}

// ── Route handlers ────────────────────────────────────────────────────

async function handleRegister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  options: WebhookApiOptions
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return json(res, 400, {
      error: error instanceof Error ? error.message : "Invalid JSON body",
    });
  }

  if (typeof body !== "object" || body === null) {
    return json(res, 400, { error: "Body must be a JSON object" });
  }

  const { url, endpoint_url, event_types, events, secret } = body as Record<
    string,
    unknown
  >;
  const rawUrl = typeof endpoint_url === "string" ? endpoint_url : url;

  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return json(res, 400, { error: "endpoint_url is required" });
  }

  try {
    await assertDeliverableUrl(rawUrl);
  } catch (error) {
    return json(res, 400, {
      error: error instanceof Error ? error.message : "Invalid endpoint_url",
    });
  }

  let eventTypes: string[];
  try {
    eventTypes = normalizeEventTypes(event_types ?? events);
  } catch (error) {
    return json(res, 400, {
      error: error instanceof Error ? error.message : "Invalid event_types",
    });
  }

  const clientSuppliedSecret = typeof secret === "string" && secret.length >= 16;
  if (typeof secret === "string" && !clientSuppliedSecret) {
    return json(res, 400, { error: "secret must be at least 16 characters" });
  }

  const signingSecret = clientSuppliedSecret ? (secret as string) : generateSecret();
  const challenge = generateChallenge();

  let registration: WebhookRegistration;
  try {
    registration = createRegistration(
      {
        id: crypto.randomUUID(),
        owner_address: owner,
        endpoint_url: rawUrl,
        secret_hash: hashSecret(signingSecret),
        secret_encrypted: encryptSecret(signingSecret),
        event_types: eventTypes,
        challenge,
      },
      options.network
    );
  } catch (error) {
    return json(res, 500, {
      error: error instanceof Error ? error.message : "Failed to store registration",
    });
  }

  // When the operator supplied the secret they can already sign the
  // challenge, so run the handshake now. When VestFlow generated it, the
  // secret is returned below and the operator triggers the handshake via
  // POST /webhooks/:id/verify once their endpoint knows it.
  if (clientSuppliedSecret) {
    const result = await verifier(options).verifyRegistration(registration.id);
    if (!result.verified) {
      return json(res, 400, {
        error: `Handshake failed: ${result.error}`,
        hint: "The registration was discarded. Fix the endpoint and register again.",
      });
    }
    return json(res, 201, {
      registration_id: registration.id,
      challenge,
      verified: true,
      registration: publicRegistration(
        getRegistration(registration.id, options.network) ?? registration
      ),
    });
  }

  return json(res, 201, {
    registration_id: registration.id,
    challenge,
    // Returned exactly once — VestFlow stores only a hash and ciphertext.
    secret: signingSecret,
    verified: false,
    next_step: `POST /webhooks/${registration.id}/verify once your endpoint can echo the handshake signature`,
    registration: publicRegistration(registration),
  });
}

async function handleVerify(
  res: http.ServerResponse,
  registration: WebhookRegistration,
  options: WebhookApiOptions
): Promise<void> {
  if (registration.verified_at) {
    return json(res, 200, {
      verified: true,
      registration: publicRegistration(registration),
    });
  }

  const result = await verifier(options).verifyRegistration(registration.id);
  if (!result.verified) {
    return json(res, 400, {
      verified: false,
      error: `Handshake failed: ${result.error}`,
      hint: "The registration was discarded. Fix the endpoint and register again.",
    });
  }

  const updated = getRegistration(registration.id, options.network);
  return json(res, 200, {
    verified: true,
    registration: updated ? publicRegistration(updated) : undefined,
  });
}

async function handleTest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  options: WebhookApiOptions
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return json(res, 400, {
      error: error instanceof Error ? error.message : "Invalid JSON body",
    });
  }

  if (typeof body !== "object" || body === null) {
    return json(res, 400, { error: "Body must be a JSON object" });
  }

  const { url, endpoint_url } = body as Record<string, unknown>;
  const rawUrl = typeof endpoint_url === "string" ? endpoint_url : url;

  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return json(res, 400, { error: "endpoint_url is required" });
  }

  // Only a URL the caller has already registered can be targeted, so this
  // route cannot be used to POST to arbitrary URLs.
  const matches = listRegistrationsByOwner(owner, options.network).filter(
    (registration) => registration.endpoint_url === rawUrl
  );
  if (matches.length === 0) {
    return json(res, 404, {
      error: "endpoint_url does not match a registered webhook",
    });
  }

  const registration = matches.find((candidate) => candidate.verified_at != null);
  if (!registration) {
    return json(res, 409, {
      error: "Webhook registration is not verified",
      hint: `POST /webhooks/${matches[0].id}/verify before sending a test event`,
    });
  }

  const result = await verifier(options).sendTestEvent(registration);
  return json(res, 200, result);
}

function handleListDeliveries(
  res: http.ServerResponse,
  registration: WebhookRegistration,
  searchParams: URLSearchParams,
  options: WebhookApiOptions
): void {
  const statusParam = searchParams.get("status");
  if (statusParam && !DELIVERY_STATUSES.includes(statusParam as DeliveryStatus)) {
    return json(res, 400, {
      error: `status must be one of: ${DELIVERY_STATUSES.join(", ")}`,
    });
  }

  const limitParam = Number(searchParams.get("limit") ?? "50");
  const offsetParam = Number(searchParams.get("offset") ?? "0");
  const limit = Number.isFinite(limitParam) ? limitParam : 50;
  const offset = Number.isFinite(offsetParam) ? offsetParam : 0;

  const deliveries = listDeliveries(
    {
      registrationId: registration.id,
      status: (statusParam as DeliveryStatus) ?? undefined,
      limit,
      offset,
    },
    options.network
  );

  json(res, 200, {
    registration_id: registration.id,
    status: statusParam ?? null,
    limit: Math.min(Math.max(limit, 1), 200),
    offset: Math.max(offset, 0),
    deliveries: deliveries.map(publicDelivery),
  });
}

function handleRetryDelivery(
  res: http.ServerResponse,
  registration: WebhookRegistration,
  deliveryId: string,
  options: WebhookApiOptions
): void {
  const delivery = getDelivery(deliveryId, options.network);
  if (!delivery || delivery.registration_id !== registration.id) {
    return json(res, 404, { error: "Delivery not found" });
  }

  if (delivery.status !== "dead_lettered" && delivery.status !== "failed") {
    return json(res, 409, {
      error: `Only dead_lettered or failed deliveries can be retried (status: ${delivery.status})`,
    });
  }

  requeueDelivery(deliveryId, Math.floor(Date.now() / 1000), options.network);
  getActiveWorker()?.wake();

  const updated = getDelivery(deliveryId, options.network);
  json(res, 202, {
    delivery: updated ? publicDelivery(updated) : undefined,
  });
}

// ── Router ────────────────────────────────────────────────────────────

/**
 * Handles any `/webhooks…` request. Returns false when the path is not a
 * webhook route so the caller can continue its own routing.
 */
export async function routeWebhookRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: WebhookApiOptions = {}
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "webhooks") return false;

  const method = req.method ?? "GET";
  const owner = authenticate(req, res);
  if (!owner) return true;

  // /webhooks
  if (segments.length === 1) {
    if (method === "POST") {
      await handleRegister(req, res, owner, options);
      return true;
    }
    if (method === "GET") {
      json(res, 200, {
        registrations: listRegistrationsByOwner(owner, options.network).map(
          publicRegistration
        ),
      });
      return true;
    }
    json(res, 405, { error: "Method not allowed" });
    return true;
  }

  // /webhooks/test — registration ids are UUIDs, so "test" never collides.
  if (segments.length === 2 && segments[1] === "test") {
    if (method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    await handleTest(req, res, owner, options);
    return true;
  }

  const registrationId = segments[1];

  // /webhooks/:id
  if (segments.length === 2) {
    const registration = requireOwnedRegistration(
      res,
      registrationId,
      owner,
      options.network
    );
    if (!registration) return true;

    if (method === "GET") {
      json(res, 200, { registration: publicRegistration(registration) });
      return true;
    }
    if (method === "DELETE") {
      disableRegistration(registrationId, options.network);
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
      return true;
    }
    json(res, 405, { error: "Method not allowed" });
    return true;
  }

  // /webhooks/:id/verify | /webhooks/:id/deliveries
  if (segments.length === 3) {
    const registration = requireOwnedRegistration(
      res,
      registrationId,
      owner,
      options.network
    );
    if (!registration) return true;

    if (segments[2] === "verify" && method === "POST") {
      await handleVerify(res, registration, options);
      return true;
    }
    if (segments[2] === "deliveries" && method === "GET") {
      handleListDeliveries(res, registration, url.searchParams, options);
      return true;
    }
    json(res, 405, { error: "Method not allowed" });
    return true;
  }

  // /webhooks/:id/deliveries/:delivery_id/retry
  if (
    segments.length === 5 &&
    segments[2] === "deliveries" &&
    segments[4] === "retry"
  ) {
    if (method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    const registration = requireOwnedRegistration(
      res,
      registrationId,
      owner,
      options.network
    );
    if (!registration) return true;

    handleRetryDelivery(res, registration, segments[3], options);
    return true;
  }

  json(res, 404, { error: "Not found" });
  return true;
}
