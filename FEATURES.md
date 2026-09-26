# VestFlow Features Guide

This document outlines all the new features implemented in VestFlow.

## Features Overview

### 🔗 Public Schedule Sharing (#127)

**Description**: Share vesting schedules publicly without requiring wallet access.

**How to Use**:
1. Navigate to any schedule in your dashboard
2. Click on the schedule to view its details
3. Copy the public share link: `vestflow.xyz/schedule/[id]`
4. Share with anyone - they can view all schedule details without a wallet

**Features**:
- View schedule details publicly
- See vesting progress in real-time
- View grantor and beneficiary addresses
- Timeline visualization
- Social media metadata (OG tags, Twitter cards)
- No wallet required

**Routes**:
- `/schedule/[id]` - Public schedule view page
- `/api/schedules/[id]` - Get schedule data via API

---

### 📊 Analytics Dashboard (#125)

**Description**: Protocol-level insights into VestFlow usage.

**How to Use**:
1. Click "Analytics" in the navigation menu
2. View real-time protocol statistics
3. Monitor key metrics and trends

**Metrics Displayed**:
- **Total Value Locked (TVL)**: Sum of all active vesting schedules
- **Total Claimed**: Tokens released to beneficiaries to date
- **Active Schedules**: Currently vesting (not yet ended)
- **Unique Beneficiaries**: Count of addresses that have claimed tokens
- **Total Schedules**: All schedules ever created
- **Revoked Schedules**: Cancelled schedules
- **TVL in USD**: Estimated USD value (using current XLM price)

**Additional Metrics**:
- Average schedule value
- Revocation rate
- Claimed vs locked ratio
- Schedules per beneficiary

**Routes**:
- `/analytics` - Analytics dashboard
- `/api/analytics/stats` - Get current stats via API

**Data Freshness**: Updates every 60 seconds (cached for performance)

---

### 🧩 Embeddable Widget (#124)

**Description**: Web component that can be embedded on any website to display vesting status.

**How to Use**:
1. Go to `/widget` page
2. Configure the schedule ID and display mode
3. Copy the generated embed code
4. Paste into your website HTML

**Basic Installation**:
```html
<script src="https://vestflow.xyz/widget.js"></script>
<vestflow-widget schedule-id="123"></vestflow-widget>
```

**Attributes**:
- `schedule-id` (required): The vesting schedule ID to display
- `minimal` (optional): Set to "true" for compact version

**Display Modes**:
- **Full**: Shows all schedule details, vesting progress, claimed/remaining amounts
- **Minimal**: Compact version with just the schedule ID, status, and progress bar

**Features**:
- Dark mode by default
- Responsive design (works on mobile and desktop)
- No external dependencies
- Lightweight (~5KB gzipped)
- Works on any website
- Real-time vesting progress
- Scoped styles (doesn't conflict with host site)

**Example with Minimal Mode**:
```html
<vestflow-widget schedule-id="42" minimal="true"></vestflow-widget>
```

**Routes**:
- `/widget` - Widget documentation and embed code generator
- `/api/schedules/[id]` - Widget data API

---

### 📚 Learning Center (#126)

**Description**: Educational content about token vesting and Soroban smart contracts, integrated with Stellar Quest.

**How to Use**:
1. Click "Learn" in the navigation menu
2. Browse learning modules by difficulty level
3. Complete modules to deepen your understanding
4. Take Stellar Quest challenges for achievements

**Learning Modules**:

#### 1. Introduction to Token Vesting (Beginner - 10 min)
- Token vesting basics
- Real-world use cases (employee compensation, investor allocation)
- Key concepts: cliff, linear vesting, revocability
- Intro to Stellar and Soroban

#### 2. Building Smart Contracts on Soroban (Intermediate - 30 min)
- Soroban fundamentals
- Writing contracts in Rust
- VestFlow contract architecture
- Core functions and events
- Security considerations
- Authorization patterns

#### 3. Frontend Integration (Intermediate - 20 min)
- Setting up Stellar SDK
- Connecting Freighter wallet
- Fetching schedule data
- Creating vesting schedules
- Best practices

#### 4. VestFlow Architecture Deep Dive (Advanced - 45 min)
- System architecture overview
- Event indexing and polling
- Checkpoint system
- Advanced vesting calculations
- Revocation semantics
- Analytics pipeline
- Security architecture
- Scaling considerations

**Features**:
- Progressive difficulty levels (Beginner → Intermediate → Advanced)
- Estimated time to complete each module
- Topic tags for easy filtering
- Code examples and explanations
- Links to official documentation
- Stellar Quest integration with challenge links

**Routes**:
- `/learn` - Learning hub with all modules

---

## New Routes Summary

| Route | Purpose | Public |
|-------|---------|--------|
| `/schedule/[id]` | View public schedule details | ✅ Yes |
| `/analytics` | Protocol analytics dashboard | ✅ Yes |
| `/widget` | Widget embed documentation | ✅ Yes |
| `/learn` | Learning center and educational content | ✅ Yes |
| `/api/schedules/[id]` | Get schedule data for public view and widget | ✅ Yes |
| `/api/analytics/stats` | Get current protocol statistics | ✅ Yes |

---

## Navigation Updates

The main Navbar now includes links to:
- Dashboard
- New Schedule
- **Analytics** (new)
- **Widget** (new)
- **Learn** (new)
- GitHub

---

## Backend Updates

### Database Schema (`indexer/schema.sql`)

Added new tables for analytics:

```sql
-- Analytics cache for real-time stats
CREATE TABLE analytics_cache (
  id INTEGER PRIMARY KEY,
  total_value_locked TEXT,
  total_claimed TEXT,
  active_schedules INTEGER,
  unique_beneficiaries INTEGER,
  total_schedules_created INTEGER,
  total_revoked INTEGER,
  last_updated INTEGER
);

-- Daily snapshots for trend tracking
CREATE TABLE daily_stats (
  date TEXT PRIMARY KEY,
  total_value_locked TEXT,
  total_claimed TEXT,
  active_schedules INTEGER,
  unique_beneficiaries INTEGER,
  total_schedules_created INTEGER,
  total_revoked INTEGER,
  created_at INTEGER
);
```

### Indexer Functions (`indexer/src/db.ts`)

New analytics-related functions:
- `getAnalyticsStats()` - Fetch current cached stats
- `computeAnalyticsStats()` - Calculate and cache stats
- `getDailyStats(days)` - Get historical daily snapshots
- `recordDailySnapshot(stats)` - Record daily snapshot

---

## Accessing the Features

### From the Dashboard
- Click "Analytics" to view protocol statistics
- Click a schedule's ID to get a shareable link
- Click "Widget" to embed schedules on your site
- Click "Learn" to access educational content

### From the Landing Page
- New "Explore More" section showcases all features
- Quick cards for each feature with descriptions

### Direct URLs
- Public schedule: `vestflow.xyz/schedule/0` (replace 0 with schedule ID)
- Analytics: `vestflow.xyz/analytics`
- Widget: `vestflow.xyz/widget`
- Learn: `vestflow.xyz/learn`

---

## API Usage Examples

### Get Schedule Data
```bash
curl https://vestflow.xyz/api/schedules/123
```

Response:
```json
{
  "schedule": {
    "id": 123,
    "grantor": "GXXX...",
    "beneficiary": "GYYY...",
    "total_amount": "1000000000",
    "claimed": "250000000",
    ...
  },
  "claimable": "50000000",
  "network": "testnet"
}
```

### Get Protocol Stats
```bash
curl https://vestflow.xyz/api/analytics/stats
```

Response:
```json
{
  "total_value_locked": "50000000000",
  "total_claimed": "10000000000",
  "active_schedules": 42,
  "unique_beneficiaries": 28,
  "total_schedules": 50,
  "total_revoked": 3,
  "tvl_usd": "6000.00",
  "last_updated": 1234567890
}
```

---

## Integration Guide

### Embedding the Widget

To embed VestFlow schedules on your website:

1. Add the script tag to your HTML:
```html
<script src="https://vestflow.xyz/widget.js"></script>
```

2. Add the widget element wherever you want to display it:
```html
<vestflow-widget schedule-id="YOUR_SCHEDULE_ID"></vestflow-widget>
```

3. (Optional) Customize the width:
```html
<style>
  vestflow-widget {
    max-width: 400px;
  }
</style>
```

### Linking to Public Schedules

Link to public schedule views to give beneficiaries an easy way to check their vesting status:

```html
<a href="https://vestflow.xyz/schedule/YOUR_SCHEDULE_ID">
  View Your Vesting Schedule
</a>
```

---

## Performance Considerations

- **Public Schedule View**: Cached for 30 seconds
- **Analytics Stats**: Cached for 60 seconds with 5-minute stale-while-revalidate
- **Widget**: Loads data on-demand with caching
- **Learning Center**: Static content (no database queries)

---

---

### 🔔 Email Notifications for Vesting Milestones (#122)

**Description**: Opt-in email notifications when important vesting events occur - cliff reached, tokens claimable, or schedule revoked.

**How to Use**:
1. Navigate to any public schedule view (`/schedule/[id]`)
2. Scroll to the "Get Notified About Milestones" section
3. Enter your email address
4. Select which events you want to be notified about
5. Click "Subscribe to Notifications"
6. Check your email and click the verification link
7. You'll receive notifications when milestones are reached

**Features**:
- Opt-in via email verification (prevents spam)
- Multiple notification types:
  - Cliff reached
  - Tokens become claimable
  - Schedule revoked
  - All events
- Rich HTML email templates
- Beautiful, branded notification emails
- Unsubscribe links in every email
- Duplicate prevention (won't send duplicate notifications)
- Error tracking for failed sends

**Notification Types**:
- **Cliff Reached**: Alerts when the cliff period ends and vesting accelerates
- **Claimable**: Notifies when tokens are available to claim
- **Revoked**: Alerts if the schedule is revoked by the grantor

**Database Tables**:
- `notification_subscriptions` - Stores user email subscriptions
- `notification_events` - Tracks sent notifications
- `notification_milestones` - Prevents duplicate notifications

**API Endpoints**:
- `POST /api/notifications/subscribe` - Subscribe to notifications
- `GET /api/notifications/verify?token=...` - Verify email subscription
- `POST /api/notifications/unsubscribe` - Unsubscribe from notifications

**Email Configuration**:
- Uses SendGrid for reliable email delivery (optional)
- Requires `SENDGRID_API_KEY` environment variable
- Falls back to console logging if SendGrid not configured
- Customizable from email via `NOTIFICATION_FROM_EMAIL`

**Routes**:
- `/schedule/[id]` - Now includes notification subscription form
- `/api/notifications/subscribe` - Create new subscription
- `/api/notifications/verify` - Verify email subscription
- `/api/notifications/unsubscribe` - Cancel subscription

---

### 🪝 Production Webhooks (#564)

**Description**: Signed, at-least-once HTTP delivery of every indexed contract event to registered endpoints, with exponential-backoff retries and a dead-letter queue. Implemented in the indexer — see [indexer/README.md](indexer/README.md#webhooks) for the full guide.

**How to Use**:
1. Register an endpoint: `POST /webhooks` with a wallet JWT, the endpoint URL and the event types you want.
2. Store the returned signing secret on your endpoint.
3. Complete the handshake: `POST /webhooks/:id/verify` — your endpoint echoes the signature VestFlow sends.
4. Receive signed `POST`s for each matching event, and answer `2xx` to acknowledge.

**Features**:
- HMAC-SHA256 request signing, `X-VestFlow-Signature: t=<unix>,v1=<hmac>`, verified in constant time
- Replay protection: signatures older than 5 minutes are rejected
- Handshake verification so an endpoint must prove it holds the secret before any event is sent (blocks SSRF via rogue registrations)
- Stable `X-VestFlow-Delivery-ID` across retries for downstream idempotency
- Durable retry schedule: 10 attempts with 1s → 256s backoff, resumed after restarts
- Dead-letter queue with manual requeue
- Non-blocking fan-out: a slow subscriber never stalls indexing

**Routes** (indexer, port 3001):
- `POST /webhooks` — register an endpoint
- `POST /webhooks/:id/verify` — run the handshake
- `DELETE /webhooks/:id` — disable a registration
- `GET /webhooks/:id/deliveries?status=&limit=` — delivery history
- `POST /webhooks/:id/deliveries/:delivery_id/retry` — requeue a dead-lettered delivery

**Configuration**: `WEBHOOK_ENCRYPTION_KEY` (required) and a `JWT_SECRET` shared with the app; delivery tuning via `WEBHOOK_CONCURRENCY`, `WEBHOOK_POLL_INTERVAL_MS` and `WEBHOOK_LEASE_SECONDS`.

---

### 📈 Portfolio Vesting Timeline (#566)

**Description**: `/app/portfolio` draws every schedule the connected wallet is party to — as grantor, as beneficiary, or both — as rows on a single interactive canvas timeline. A draggable time cursor re-projects each schedule's claimable amount in real time, and clicking a row opens a detail drawer.

**How to Use**:
1. Connect your wallet and open **Portfolio** from the navbar.
2. Drag the time axis (or the red cursor line) to scrub through time; every row's projected claimable amount updates as you drag.
3. Drag a row to pan, hold <kbd>Shift</kbd>/<kbd>Ctrl</kbd> while scrolling to zoom, and use **Fit** to frame the whole portfolio again.
4. Click a row to open its detail drawer, or use the arrow keys and <kbd>Enter</kbd> from the keyboard.

**Features**:
- One `<canvas>` for the whole portfolio with virtualised rows — only the rows inside the viewport are drawn each frame, so 200+ schedules paint in well under 100 ms
- Repaints are pull-based: interaction sets a dirty flag and a `requestAnimationFrame` loop redraws only when needed
- Cursor recalculation runs in a Web Worker (`workers/claimable-calculator.worker.ts`), keeping a drag at 60 fps; 200 schedules are re-projected in well under one 16 ms frame
- Per-kind visual treatments on the same row height budget: hatched cliff periods, a gradient vesting body, tick markers at each graded tranche, and one sub-row per token on multi-token schedules
- Hit-testing by binary search over row positions, so clicks resolve in ~8 comparisons regardless of portfolio size
- Pan and zoom via a single float transform, correct from a one-hour view out to five years, with off-screen spans clipped so canvas coordinates never overflow
- Canvas colours read from the app's CSS custom properties, so the timeline follows the light and dark themes
- Honours `prefers-reduced-motion`: the cursor snaps instead of easing and the loading skeleton stops shimmering
- Falls back to computing on the main thread wherever a Web Worker is unavailable

**Routes**:
- `/app/portfolio` — the timeline page
- `GET /api/schedules?grantor=<address>` and `GET /api/schedules?beneficiary=<address>` — role-scoped schedule lists, fetched in parallel and merged by schedule id

**Build note**: the worker is bundled to `public/workers/` by `npm run worker:build`, which `prebuild` and `predev` run automatically.

---

## Future Enhancements

Potential improvements for future releases:
- Advanced analytics charts (Recharts/Chart.js integration)
- Push notifications (in-app)
- SMS notifications as alternative to email
- CSV export of schedule data
- Batch schedule creation
- Schedule analytics per grantor/beneficiary
- Widget customization (colors, fonts)
- More Stellar Quest integrations

---

## Support

For issues or questions:
- GitHub: [vestflow-labs/vestflow](https://github.com/vestflow-labs/vestflow)
- Stellar Community: [stellar.org/community](https://stellar.org/community)
- Stellar Quest: [stellar.quest](https://stellar.quest)
