# VestFlow Event Indexer

Off-chain historical event indexer for the VestFlow Soroban contract.

---

## Architecture

```
Stellar RPC (getEvents)
        │
        ▼
  indexer/src/poller.ts   ← long-lived Node.js process
        │  polls every POLL_INTERVAL_MS, follows cursor pagination
        │  decodes ScVal topics/values to JSON
        │  writes idempotently via INSERT OR IGNORE
        ▼
  vestflow-events-*.db    ← SQLite per network (WAL mode)
  schema: schedule_events + checkpoint
        │
        ▼
  indexer/src/server.ts   ← lightweight HTTP query API (:3001)
        │
        ▼
  app/api/events/route.ts ← Next.js proxy route
```

### Why Stellar RPC polling (not Horizon)?

VestFlow uses Soroban smart contracts. Soroban contract events are
accessible via the Stellar RPC `getEvents` endpoint, not the classic
Horizon `/effects` or `/transactions` APIs. Horizon does not surface
custom Soroban contract events.

### Why SQLite?

- Zero infrastructure: works locally without Docker or a cloud DB.
- WAL mode allows concurrent reads (query server) + writes (poller).
- Trivial to swap for Postgres/PlanetScale when scaling up.

---

## Event types

| `event_type`       | Topics parsed              | Notes                          |
|--------------------|----------------------------|--------------------------------|
| `schedule_created` | topics `[created, id]`, value includes grantor, beneficiary, token, amount | Emitted on `create_schedule` |
| `claimed`          | topics `[claimed, beneficiary, token]`, value includes schedule ID and amount | Emitted on `claim` |
| `revoked`          | topics `[revoked, grantor, token]`, value includes schedule ID and unvested amount | Emitted on `revoke` |
| `unknown`          | raw JSON stored            | Future-proofs new event types  |

---

## Setup

```bash
cd indexer
cp .env.example .env
# Edit .env — set CONTRACT_ID, RPC_URL, etc.
npm install
```

### Local development

```bash
# Option A: run poller + query server together
npm run dev:all

# Option B: run separately in two terminals
npm run dev          # poller
npm run dev:server   # query HTTP server
```

The Next.js app proxies `/api/events` and `/api/stats/tvl` to the indexer.
Pass `?network=testnet|mainnet` to select the indexed network.
Any other value is rejected with HTTP 400 rather than silently reading the
wrong network. Run one poller process per network (with its own
`INDEXER_NETWORK`); the query server reads both per-network databases.

### Production

Build and run the compiled output:

```bash
npm run build
npm start          # poller (keep alive with PM2 / systemd / fly.io)
npm run start:server  # query server
```

Set `INDEXER_URL` in your Next.js deployment environment to point at the
running query server, or set `INDEXER_TESTNET_URL` and `INDEXER_MAINNET_URL`
when the networks are served by separate indexer deployments.

### Database pool configuration

The indexer validates these variables at startup and fails with the variable
name and accepted range when a value is invalid:

| Variable | Default | Accepted values |
|----------|---------|-----------------|
| `DB_POOL_MIN` | `0` | Non-negative safe integer, no greater than `DB_POOL_MAX` |
| `DB_POOL_MAX` | `20` | Positive safe integer |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Integer from `0` through `2147483647` milliseconds |

PostgreSQL applies the values as `min`, `max`, and `idleTimeoutMillis` on its
connection pool. SQLite uses one shared WAL connection per network and does
not create a native connection pool.

---

## Query API

Base URL: `http://localhost:3001` (local) or your deployed service URL.

### `GET /metrics`

Prometheus text format is available at the root path, not under `/v1/`.
Set `METRICS_TOKEN` and send `Authorization: Bearer <token>`.

The response exposes `http_requests_total`, `http_request_duration_seconds`,
`active_streams_count`, `indexer_lag_ledgers`, and
`db_pool_connections_active`.

### `GET /streams/history/:sender/:receiver/:token`

Returns chronological stream changes for one sender/receiver/token pair. Each
history row contains `ledger`, Unix `timestamp`, `old_rate`, `new_rate`, and
`action` (`open`, `rate_change`, or `close`). Use `limit` (default 50, max 200)
and the returned `next_cursor` for pagination. The endpoint returns 404 when
no history exists.

### `GET /health`

```json
{ "ok": true, "network": "testnet", "checkpoint": 5678901 }
```

### `GET /events`

All parameters optional:

| Param        | Type   | Description                                |
|--------------|--------|--------------------------------------------|
| `address`    | string | Match grantor **or** beneficiary           |
| `grantor`    | string | Exact grantor address match                |
| `beneficiary`| string | Exact beneficiary address match            |
| `event_type` | string | `schedule_created` \| `claimed` \| `revoked` |
| `schedule_id`| number | Filter by schedule ID                      |
| `from_ledger`| number | Lower ledger bound (inclusive)             |
| `to_ledger`  | number | Upper ledger bound (inclusive)             |
| `limit`      | number | Max results (default 50, max 200)          |
| `offset`     | number | Pagination offset (default 0)              |
| `network`    | string | `testnet` or `mainnet` (default `testnet`) |

**Example:**
```
GET /events?network=testnet&address=GABC...&event_type=claimed&limit=20
```

**Response:**
```json
{
  "events": [
    {
      "id": "5678901-0-0",
      "event_type": "claimed",
      "ledger": 5678901,
      "ledger_closed_at": "2025-06-01T12:00:00Z",
      "schedule_id": 7,
      "grantor": null,
      "beneficiary": "GABC...",
      "amount": "5000000",
      "raw_topics": "[\"claimed\",7,\"GABC...\",\"5000000\"]",
      "raw_value": "null",
      "created_at": 1748779200
    }
  ],
  "network": "testnet",
  "checkpoint": 5678901
}
```

### `GET /stats/tvl`

Aggregates total value locked per asset from indexed schedule creation,
claim, and revoke events.

**Example:**
```
GET /stats/tvl?network=testnet
```

**Response:**
```json
{
  "network": "testnet",
  "assets": [
    {
      "asset": "CDLZ...",
      "total_created": "10000000",
      "total_claimed": "2500000",
      "total_revoked_unvested": "0",
      "total_value_locked": "7500000",
      "active_schedules": 3
    }
  ],
  "total_value_locked": "7500000",
  "last_updated": 1766534400
}
```

---

## Analytics API

Materialized daily snapshots, folded in incrementally by `analytics.ts`
after each processed ledger batch (see `materialize()` in that file). These
endpoints read only from `schedule_daily_snapshots`, `token_daily_tvl` and
`grantor_daily_stats` — never from raw `schedule_events` — so they stay fast
regardless of total event volume.

### `GET /analytics/tvl`

Daily TVL for a single token. Query params: `token` (required, asset
contract address), `from`, `to` (ISO 8601, default: last 30 days),
`cumulative` (`true` for a running total instead of the per-day balance),
`network` (`testnet` | `mainnet`, default `testnet`). Responses are served
from a 60s in-memory LRU cache (100 entries), invalidated for "today" only
whenever a new ledger changes that day's numbers.

```
GET /analytics/tvl?token=CDLZ...&from=2026-07-01&to=2026-08-01&cumulative=true
```

```json
{
  "token": "CDLZ...",
  "from": "2026-07-01",
  "to": "2026-08-01",
  "cumulative": true,
  "decimals": 7,
  "points": [
    { "day": "2026-07-01", "total_locked_stroops": "7500000", "active_schedule_count": 3, "total_locked_display": "0.75" }
  ],
  "cached": false
}
```

### `GET /analytics/schedules/:id/history`

Daily `{ vested, claimed, claimable, locked }` for one schedule, gap-filled:
a day with no activity repeats the last known values instead of a hole.
Query params: `from`, `to` (default: last 30 days).

### `GET /analytics/grantors/:address/summary`

`{ total_schedules_created, total_distributed, active_schedules,
revoked_schedules, avg_duration_days }` for every schedule the address has
created.

---

## Webhooks

Every indexed event is fanned out to registered HTTP endpoints with signed
requests, exponential-backoff retries and a dead-letter queue.

```
poller ─insert event─▶ fan-out (writes rows only, never blocks indexing)
                            │
                    webhook_deliveries          ┌── 2xx ──▶ delivered
                            │                   │
                    delivery worker pool ───────┼── 5xx/timeout ──▶ pending (retry)
                    (10 concurrent, polls 1s)   │
                                                └── attempt 10 ──▶ dead_lettered
```

### Registering an endpoint

All management routes require `Authorization: Bearer <wallet JWT>` — the
token minted by the app's `POST /api/auth/verify`. The indexer and the app
must therefore share `JWT_SECRET`.

```bash
curl -X POST http://localhost:3001/webhooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"endpoint_url":"https://hooks.example.com/vestflow","event_types":["claimed","revoked"]}'
```

```json
{
  "registration_id": "0f1c…",
  "challenge": "9c2e…",
  "secret": "3b91…",            // returned exactly once
  "verified": false,
  "next_step": "POST /webhooks/0f1c…/verify once your endpoint can echo the handshake signature"
}
```

`event_types` accepts any of `schedule_created`, `claimed`, `revoked`,
`proposal_created`, `proposal_acknowledged`, `proposal_activated`,
`proposal_expired`, or `["*"]` for everything.

### Handshake (required before any event is sent)

1. Store the returned `secret` on your endpoint.
2. Call `POST /webhooks/:id/verify`. VestFlow POSTs
   `{"type":"webhook.handshake","registration_id":…,"challenge":…}` with an
   `X-VestFlow-Signature` header.
3. Answer `200` within 10 seconds, echoing the **identical** signature —
   either in the `X-VestFlow-Signature` response header or as
   `{"signature":"t=…,v1=…"}` in the body.
4. On success `verified_at` is set and events start flowing. On failure the
   registration is deleted.

If you already share a secret out of band, pass it as `secret` in the
registration body and the handshake runs immediately as part of `POST
/webhooks`.

The handshake is what prevents an attacker from pointing VestFlow at
`http://internal-service/admin`: only someone holding the secret can produce
the echo. Endpoint URLs must additionally be `https://` and must not resolve
to loopback, link-local or private ranges (set
`WEBHOOK_ALLOW_INSECURE_URLS=true` for local development).

### Delivery requests

| Header                    | Value                                             |
|---------------------------|---------------------------------------------------|
| `X-VestFlow-Delivery-ID`  | UUID, **stable across every retry** — deduplicate on it |
| `X-VestFlow-Event`        | event type, e.g. `claimed`                        |
| `X-VestFlow-Event-ID`     | Stellar event ID `<ledger>-<txIndex>-<eventIndex>`|
| `X-VestFlow-Attempt`      | 1-based attempt number                            |
| `X-VestFlow-Signature`    | `t=<unix>,v1=<hmac-sha256>`                       |

The signature is `HMAC-SHA256(secret, "<t>.<raw body>")`. Verify it over the
**raw** body, and reject timestamps older than 5 minutes so a captured
request cannot be replayed:

```js
import crypto from "crypto";

function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(
    header.split(",").map((part) => part.split("=").map((s) => s.trim()))
  );
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;

  const expected = Buffer.from(
    crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"),
    "hex"
  );
  const provided = Buffer.from(v1, "hex");
  // Constant time — a `===` comparison leaks the digest byte by byte.
  return (
    expected.length === provided.length &&
    crypto.timingSafeEqual(expected, provided)
  );
}
```

Answer `2xx` to acknowledge. Anything else (or no answer within 10s) is
retried; `410 Gone` tells VestFlow to stop permanently.

### Retries and the dead-letter queue

Delays double after each failed attempt — `2^(n-1)` seconds:

| Failed attempt | 1 | 2 | 3 | 4  | 5  | 6  | 7  | 8   | 9   | 10            |
|----------------|---|---|---|----|----|----|----|-----|-----|---------------|
| Next retry in  | 1s| 2s| 4s| 8s | 16s| 32s| 64s| 128s| 256s| dead-lettered |

Every transition is committed to the database before the request is made, so
a restart resumes pending retries; deliveries stranded `in_flight` by a
crashed process are reclaimed after `WEBHOOK_LEASE_SECONDS`.

### Management API

| Route                                                | Purpose                        |
|------------------------------------------------------|--------------------------------|
| `POST /webhooks`                                      | Register an endpoint           |
| `GET /webhooks`                                       | List your registrations        |
| `POST /webhooks/test`                                 | Send a test event to a registered endpoint |
| `GET /webhooks/:id`                                   | Registration detail            |
| `POST /webhooks/:id/verify`                           | Run the handshake              |
| `DELETE /webhooks/:id`                                | Disable a registration         |
| `GET /webhooks/:id/deliveries?status=&limit=&offset=` | Delivery history               |
| `POST /webhooks/:id/deliveries/:delivery_id/retry`    | Requeue a dead-lettered delivery |

### Configuration

| Variable                      | Default | Purpose                                        |
|-------------------------------|---------|------------------------------------------------|
| `WEBHOOK_ENCRYPTION_KEY`      | —       | 32-byte hex AES key; **required** to enable webhooks |
| `JWT_SECRET`                  | —       | Shared with the app; authenticates management calls |
| `WEBHOOK_CONCURRENCY`         | `10`    | Concurrent delivery requests                   |
| `WEBHOOK_POLL_INTERVAL_MS`    | `1000`  | Queue poll interval                            |
| `WEBHOOK_LEASE_SECONDS`       | `120`   | When to reclaim a stranded `in_flight` delivery |
| `WEBHOOK_DELIVERY_ENABLED`    | `true`  | Set `false` to queue without delivering        |
| `WEBHOOK_ALLOW_INSECURE_URLS` | `false` | Allow `http://` and private hosts (dev only)   |

Secrets are never stored in plaintext: `webhook_registrations.secret_hash`
holds a scrypt hash, and `secret_encrypted` holds AES-256-GCM ciphertext
that the worker decrypts in memory only to sign a request. Rotating
`WEBHOOK_ENCRYPTION_KEY` invalidates existing registrations.

A `WEBHOOK_ENCRYPTION_KEY` that is not 64 hex characters is stretched to 32
bytes with SHA-256 and logs a warning once at startup: the derived key is
well-formed but carries only the entropy of the value you supplied, so
prefer a generated key.

### Load test

```bash
npm run test:webhook-load     # 10,000 events × 10 endpoints = 100,000 deliveries
```

The mock receiver fails a fixed 10% of events, so the run asserts 90,000
`delivered`, 10,000 `dead_lettered` (each after exactly 10 attempts), zero
left `pending`/`in_flight`, and one stable delivery ID per delivery. Scale it
with `WEBHOOK_LOAD_EVENTS`, `WEBHOOK_LOAD_ENDPOINTS` and
`WEBHOOK_LOAD_CONCURRENCY`.

---

## Idempotency & replay safety

- Each Stellar event has a globally unique `id` (`ledger-txIndex-eventIndex`).
- Inserts use `INSERT OR IGNORE` — re-processing a batch is a no-op.
- The checkpoint is updated after each page, not after the full run.
- On crash, at most one page (≤ 200 events) is re-processed; duplicate
  inserts are discarded automatically.
- To replay from a specific ledger: delete `vestflow-events.db` (or
  `UPDATE checkpoint SET last_ledger = <ledger>`) and set `START_LEDGER`.

---

## Scalability tradeoffs

| Concern             | Current approach         | Scale-up path                  |
|---------------------|--------------------------|--------------------------------|
| Storage             | SQLite on local disk     | Postgres / PlanetScale / Neon  |
| Poller redundancy   | Single process           | Leader election (e.g. Redlock) |
| Query latency       | SQLite sequential reads  | Indexed PG with connection pooling |
| Deployment          | PM2 / fly.io process     | Dedicated microservice / Cloud Run |
| Cron instead of loop| Polling loop in process  | Vercel cron + serverless worker |

---

## Vercel cron integration (optional)

If you prefer a fully serverless approach (no long-lived process):

1. Move the poll logic into `app/api/cron/index-events/route.ts`.
2. Add to `vercel.json`:
   ```json
   { "crons": [{ "path": "/api/cron/index-events", "schedule": "* * * * *" }] }
   ```
3. Use a hosted DB (Neon, Upstash, Supabase) instead of SQLite.

The standalone-process approach in this indexer is easier for local
development and avoids serverless cold-start latency on each poll.
