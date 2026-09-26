/**
 * VestFlow Webhooks — protocol core
 *
 * Pure, side-effect-free helpers shared by the delivery worker, the HTTP
 * API and the test suite:
 *
 *   - Stripe-style request signing (`t=<unix>,v1=<hmac>`) and timing-safe
 *     verification with a replay window.
 *   - Secret generation, scrypt hashing (never store the plaintext) and
 *     AES-256-GCM encryption (the worker must be able to recover the
 *     secret in memory to sign outgoing requests — a one-way hash alone
 *     cannot sign).
 *   - The exponential backoff schedule for retries.
 *   - SSRF guards applied before any HTTP request leaves the process.
 */

import crypto from "crypto";
import dns from "dns";
import type { EventType } from "./types";

/** Attempts after which a delivery is dead-lettered instead of retried. */
export const MAX_ATTEMPTS = 10;

/** Signatures older than this are rejected by receivers (replay window). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Per-request timeout for both handshake and event delivery. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Base unit of the backoff schedule; compressed in load tests. */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;

/** Subscribable event types, plus the `*` wildcard for "everything". */
export const SUBSCRIBABLE_EVENT_TYPES: readonly string[] = [
  "schedule_created",
  "claimed",
  "revoked",
  "proposal_created",
  "proposal_acknowledged",
  "proposal_activated",
  "proposal_expired",
];

export const WILDCARD_EVENT_TYPE = "*";

/** JSON body POSTed to subscribers. */
export interface WebhookEventPayload {
  /** Stellar event ID: "<ledger>-<txIndex>-<eventIndex>". */
  event_id: string;
  event_type: EventType | string;
  network: string;
  ledger: number;
  ledger_closed_at: string;
  schedule_id: number | null;
  proposal_id: number | null;
  grantor: string | null;
  beneficiary: string | null;
  token: string | null;
  amount: string | null;
  created_amount: string | null;
}

// ── Backoff ───────────────────────────────────────────────────────────

/**
 * Delay before the next retry, in seconds, after `attemptCount` failed
 * attempts: 2^(attemptCount - 1).
 *
 *   attempt 1 failed →    1s     attempt 6 failed →   32s
 *   attempt 2 failed →    2s     attempt 7 failed →   64s
 *   attempt 3 failed →    4s     attempt 8 failed →  128s
 *   attempt 4 failed →    8s     attempt 9 failed →  256s
 *   attempt 5 failed →   16s     attempt 10 failed → dead-lettered
 */
export function backoffDelaySeconds(attemptCount: number): number {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error(`attemptCount must be a positive integer, got ${attemptCount}`);
  }
  return 2 ** (attemptCount - 1);
}

/** The full retry schedule actually used before a delivery is dead-lettered. */
export const RETRY_SCHEDULE_SECONDS: readonly number[] = Array.from(
  { length: MAX_ATTEMPTS - 1 },
  (_unused, index) => backoffDelaySeconds(index + 1)
);

// ── Signing ───────────────────────────────────────────────────────────

export interface ParsedSignature {
  timestamp: number;
  signature: string;
}

/**
 * Computes the HMAC over `<timestamp>.<body>` rather than the body alone,
 * so a captured signature cannot be replayed with a fresh timestamp.
 */
export function computeSignature(
  secret: string,
  body: string,
  timestampSeconds: number
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`, "utf8")
    .digest("hex");
}

/** Builds the `X-VestFlow-Signature` header value. */
export function signPayload(
  secret: string,
  body: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000)
): string {
  return `t=${timestampSeconds},v1=${computeSignature(secret, body, timestampSeconds)}`;
}

/** Parses `t=<unix>,v1=<hex>`; returns null when malformed. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  if (typeof header !== "string") return null;

  let timestamp: number | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) return null;
      timestamp = parsed;
    } else if (key === "v1") {
      if (!/^[0-9a-f]+$/i.test(value)) return null;
      signature = value.toLowerCase();
    }
  }

  if (timestamp == null || signature == null) return null;
  return { timestamp, signature };
}

export interface VerifyOptions {
  /** Replay window in seconds (default 300). */
  toleranceSeconds?: number;
  /** Unix seconds; injectable for deterministic tests. */
  nowSeconds?: number;
}

/**
 * Verifies a `X-VestFlow-Signature` header against the raw request body.
 *
 * Uses `crypto.timingSafeEqual` — a `===` comparison on the hex digest
 * short-circuits on the first differing byte, which leaks enough timing
 * information to recover a valid signature byte by byte.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  options: VerifyOptions = {}
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) return false;

  const expected = Buffer.from(
    computeSignature(secret, body, parsed.timestamp),
    "hex"
  );
  const provided = Buffer.from(parsed.signature, "hex");

  // timingSafeEqual throws on length mismatch, so compare lengths first —
  // the length of a digest is not secret.
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

/**
 * Constant-time equality for two hex strings (used to compare the
 * handshake signature echoed back by an endpoint).
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  const left = Buffer.from(a.toLowerCase(), "hex");
  const right = Buffer.from(b.toLowerCase(), "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// ── Secrets ───────────────────────────────────────────────────────────

const SCRYPT_KEYLEN = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/** Generates a 256-bit signing secret, hex encoded. */
export function generateSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Generates the one-time handshake challenge token. */
export function generateChallenge(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * scrypt hash of a secret: `scrypt$N$r$p$<saltHex>$<hashHex>`.
 * Memory-hard like bcrypt, but built into Node — the indexer intentionally
 * carries no native password-hashing dependency.
 */
export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(secret, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return [
    "scrypt",
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

/** Timing-safe check of a presented secret against a stored scrypt hash. */
export function verifySecretHash(secret: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltHex, hashHex] = parts;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) {
    return false;
  }

  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
    const derived = crypto.scryptSync(
      secret,
      Buffer.from(saltHex, "hex"),
      expected.length,
      cost
    );
    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

/** Guards the derived-key warning so it is logged once per process. */
let warnedAboutDerivedKey = false;

/** Resets the once-per-process warning latch. Test seam. */
export function resetEncryptionKeyWarning(): void {
  warnedAboutDerivedKey = false;
}

/**
 * Resolves the AES key for secret encryption from WEBHOOK_ENCRYPTION_KEY.
 * A 64-character hex value is used verbatim; any other value is stretched to
 * 32 bytes with SHA-256 so a short value cannot break the cipher outright.
 *
 * Stretching produces a well-formed key of the wrong strength — the stored
 * secrets are only as strong as the configured value's entropy — so the
 * derived path warns once rather than failing, which would take down a
 * deployment already relying on it.
 */
export function getEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = env.WEBHOOK_ENCRYPTION_KEY;
  if (!configured) {
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY is not set — webhook signing secrets cannot be stored securely"
    );
  }
  if (/^[0-9a-f]{64}$/i.test(configured)) {
    return Buffer.from(configured, "hex");
  }

  if (!warnedAboutDerivedKey) {
    warnedAboutDerivedKey = true;
    console.warn(
      "[webhooks] WEBHOOK_ENCRYPTION_KEY is not 64 hex characters — deriving a key " +
        "with SHA-256. Stored webhook secrets are only as strong as this value's " +
        "entropy. Generate a proper key with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return crypto.createHash("sha256").update(configured, "utf8").digest();
}

/** AES-256-GCM encrypt: `v1.<ivB64>.<tagB64>.<ciphertextB64>`. */
export function encryptSecret(secret: string, key: Buffer = getEncryptionKey()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/** Reverses {@link encryptSecret}; throws when the ciphertext was tampered with. */
export function decryptSecret(
  encrypted: string,
  key: Buffer = getEncryptionKey()
): string {
  const parts = encrypted.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Malformed encrypted webhook secret");
  }
  const [, ivB64, tagB64, ciphertextB64] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ── Delivery identity ─────────────────────────────────────────────────

// Fixed namespace so a (registration, event) pair always maps to the same
// delivery UUID, even across restarts and re-indexing.
const DELIVERY_NAMESPACE = "6f9b1e2c-6a1e-4f2f-9d2b-8f1c3e5a7d40";

/**
 * RFC 4122 v5-style UUID derived from the registration and event IDs.
 * Guarantees the X-VestFlow-Delivery-ID is stable for a given event and
 * endpoint no matter how many times fan-out runs.
 */
export function deliveryIdFor(registrationId: string, eventId: string): string {
  const namespace = Buffer.from(DELIVERY_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = crypto
    .createHash("sha1")
    .update(namespace)
    .update(`${registrationId}:${eventId}`, "utf8")
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

// ── Subscription matching ─────────────────────────────────────────────

/** True when a registration's `event_types` cover the given event type. */
export function matchesEventType(
  subscribed: readonly string[],
  eventType: string
): boolean {
  return subscribed.includes(WILDCARD_EVENT_TYPE) || subscribed.includes(eventType);
}

/** Validates the `event_types` array supplied at registration time. */
export function normalizeEventTypes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("event_types must be a non-empty array");
  }
  const normalized = input.map((value) => {
    if (typeof value !== "string") {
      throw new Error("event_types entries must be strings");
    }
    const trimmed = value.trim();
    if (
      trimmed !== WILDCARD_EVENT_TYPE &&
      !SUBSCRIBABLE_EVENT_TYPES.includes(trimmed)
    ) {
      throw new Error(
        `Unknown event type "${trimmed}". Allowed: ${[
          WILDCARD_EVENT_TYPE,
          ...SUBSCRIBABLE_EVENT_TYPES,
        ].join(", ")}`
      );
    }
    return trimmed;
  });
  return Array.from(new Set(normalized));
}

// ── SSRF guards ───────────────────────────────────────────────────────

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
];

/** True for loopback, link-local, unique-local and private-range addresses. */
export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::" || normalized === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10
  return PRIVATE_IPV4.some((pattern) => pattern.test(normalized));
}

export interface UrlCheckOptions {
  /** Allow http:// and private targets — local development and tests only. */
  allowInsecure?: boolean;
  /** Injectable resolver for tests. */
  lookup?: (hostname: string) => Promise<string[]>;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dns.promises.lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * Rejects endpoints that would turn VestFlow into an SSRF proxy: non-HTTPS
 * schemes, embedded credentials, and hostnames that resolve into private
 * network ranges. The handshake is the primary defence — this closes the
 * window before an unverified endpoint is ever contacted.
 */
export async function assertDeliverableUrl(
  rawUrl: string,
  options: UrlCheckOptions = {}
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("endpoint_url must be a valid absolute URL");
  }

  const allowInsecure =
    options.allowInsecure ?? process.env.WEBHOOK_ALLOW_INSECURE_URLS === "true";

  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new Error("endpoint_url must use https://");
  }
  if (url.username || url.password) {
    throw new Error("endpoint_url must not embed credentials");
  }
  if (allowInsecure) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("endpoint_url must not target a private or loopback address");
  }

  const lookup = options.lookup ?? defaultLookup;
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new Error(`endpoint_url host "${hostname}" could not be resolved`);
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("endpoint_url must not target a private or loopback address");
  }

  return url;
}
