/**
 * Loading and normalising portfolio data.
 *
 * The timeline needs every schedule the wallet touches in either direction, so
 * it fetches the grantor and beneficiary views in parallel and merges them by
 * schedule id. A schedule that appears in both (self-vesting, or a grantor who
 * is also the beneficiary) collapses to a single row tagged `both` rather than
 * being drawn twice.
 */

import type { TimelineRole, TimelineSchedule, TokenLeg, VestingKind } from "./types";

/** Row shape returned by `GET /api/schedules`. Amounts arrive as decimal strings. */
export interface ApiScheduleRow {
  id?: number | string;
  schedule_id?: number | string;
  grantor?: string;
  beneficiary?: string;
  token?: string;
  total_amount?: string | number;
  claimed?: string | number;
  start_time?: number | string;
  duration?: number | string;
  cliff_duration?: number | string;
  lockup_duration?: number | string;
  kind?: string;
  revoked?: boolean;
  paused?: boolean;
  paused_duration?: number | string;
  paused_at?: number | string;
  vested_at_revoke?: string | number;
  milestones?: { pct?: number; timestamp?: number }[];
  tokens?: {
    token?: string;
    total_amount?: string | number;
    claimed?: string | number;
    claimed_amount?: string | number;
  }[];
}

const KINDS: VestingKind[] = ["Linear", "Cliff", "LinearWithCliff", "Graded"];

/**
 * Convert one API row into a timeline row.
 *
 * Returns `null` for rows without a usable id — a malformed entry should drop
 * out of the view rather than take the whole canvas down with it.
 */
export function parseTimelineSchedule(
  raw: ApiScheduleRow,
  role: TimelineRole
): TimelineSchedule | null {
  const id = toNumber(raw.schedule_id ?? raw.id, NaN);
  if (!Number.isFinite(id)) return null;

  const tokens: TokenLeg[] =
    Array.isArray(raw.tokens) && raw.tokens.length > 0
      ? raw.tokens.map((t) => ({
          token: t.token ?? "",
          total_amount: toBigInt(t.total_amount),
          claimed: toBigInt(t.claimed ?? t.claimed_amount),
        }))
      : [
          {
            token: raw.token ?? "",
            total_amount: toBigInt(raw.total_amount),
            claimed: toBigInt(raw.claimed),
          },
        ];

  const kind = KINDS.includes(raw.kind as VestingKind)
    ? (raw.kind as VestingKind)
    : "Linear";

  return {
    id,
    grantor: raw.grantor ?? "",
    beneficiary: raw.beneficiary ?? "",
    role,
    kind,
    start_time: toNumber(raw.start_time, 0),
    duration: toNumber(raw.duration, 0),
    cliff_duration: toNumber(raw.cliff_duration, 0),
    lockup_duration: toNumber(raw.lockup_duration, 0),
    paused: Boolean(raw.paused),
    paused_duration: toNumber(raw.paused_duration, 0),
    paused_at: toNumber(raw.paused_at, 0),
    revoked: Boolean(raw.revoked),
    vested_at_revoke: toBigInt(raw.vested_at_revoke),
    tokens,
    milestones: Array.isArray(raw.milestones)
      ? raw.milestones.map((m) => ({
          pct: toNumber(m?.pct, 0),
          timestamp: toNumber(m?.timestamp, 0),
        }))
      : [],
  };
}

/**
 * Merge the grantor and beneficiary result sets into one ordered row list.
 *
 * Rows are sorted by start time so the canvas reads left-to-right as a
 * chronological stack, with the id as a tiebreaker for a stable order across
 * reloads.
 */
export function mergeSchedules(
  grantorRows: ApiScheduleRow[],
  beneficiaryRows: ApiScheduleRow[]
): TimelineSchedule[] {
  const byId = new Map<number, TimelineSchedule>();

  for (const raw of grantorRows) {
    const parsed = parseTimelineSchedule(raw, "grantor");
    if (parsed) byId.set(parsed.id, parsed);
  }
  for (const raw of beneficiaryRows) {
    const parsed = parseTimelineSchedule(raw, "beneficiary");
    if (!parsed) continue;
    const existing = byId.get(parsed.id);
    if (existing) {
      existing.role = existing.role === "grantor" ? "both" : existing.role;
    } else {
      byId.set(parsed.id, parsed);
    }
  }

  return [...byId.values()].sort(
    (a, b) => a.start_time - b.start_time || a.id - b.id
  );
}

/** Upper bound requested from the API — the portfolio view is not paginated. */
export const PORTFOLIO_PAGE_LIMIT = 500;

/**
 * Fetch both role views in parallel and return the merged row list.
 *
 * `fetchImpl` is injectable so tests can drive the loader without a network or
 * a global fetch stub.
 */
export async function fetchPortfolioSchedules(
  address: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<TimelineSchedule[]> {
  const query = `limit=${PORTFOLIO_PAGE_LIMIT}`;
  const [grantorRes, beneficiaryRes] = await Promise.all([
    fetchImpl(`/api/schedules?grantor=${encodeURIComponent(address)}&${query}`, { signal }),
    fetchImpl(`/api/schedules?beneficiary=${encodeURIComponent(address)}&${query}`, { signal }),
  ]);

  if (!grantorRes.ok && !beneficiaryRes.ok) {
    throw new Error(`Failed to load schedules (${grantorRes.status}/${beneficiaryRes.status})`);
  }

  const [grantorBody, beneficiaryBody] = await Promise.all([
    grantorRes.ok ? grantorRes.json() : Promise.resolve({ schedules: [] }),
    beneficiaryRes.ok ? beneficiaryRes.json() : Promise.resolve({ schedules: [] }),
  ]);

  return mergeSchedules(
    Array.isArray(grantorBody?.schedules) ? grantorBody.schedules : [],
    Array.isArray(beneficiaryBody?.schedules) ? beneficiaryBody.schedules : []
  );
}

function toNumber(v: unknown, fallback: number): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return 0n;
}
