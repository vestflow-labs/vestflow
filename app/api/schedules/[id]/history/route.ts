import { NextRequest, NextResponse } from "next/server";
import { getSchedule, NETWORK } from "@/lib/stellar";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3001";

function indexerUrlFor(network: string | null): string {
  if (network === "mainnet") {
    return process.env.INDEXER_MAINNET_URL ?? INDEXER_URL;
  }
  return process.env.INDEXER_TESTNET_URL ?? INDEXER_URL;
}

export interface ScheduleHistoryEvent {
  id: string;
  type: "created" | "claimed" | "revoked" | "paused" | "unknown";
  schedule_id: number;
  timestamp: number;
  ledger?: number;
  actor?: string | null;
  grantor?: string | null;
  beneficiary?: string | null;
  amount?: string | null;
  token?: string | null;
}

function normalizeEventType(rawType: string): "created" | "claimed" | "revoked" | "paused" | "unknown" {
  if (rawType === "schedule_created" || rawType === "created") return "created";
  if (rawType === "claimed") return "claimed";
  if (rawType === "revoked") return "revoked";
  if (rawType === "paused") return "paused";
  return "unknown";
}

export const GET = withLogging(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const { id } = await params;
    const scheduleId = parseInt(id, 10);

    if (isNaN(scheduleId) || scheduleId <= 0) {
      return NextResponse.json(
        { error: "Invalid schedule ID" },
        { status: 400 }
      );
    }

    const network = request.nextUrl.searchParams.get("network") ?? NETWORK;

    // Try fetching events from indexer endpoint
    try {
      const upstream = new URL(`${indexerUrlFor(network)}/events`);
      upstream.searchParams.set("schedule_id", scheduleId.toString());

      const res = await fetch(upstream.toString(), {
        next: { revalidate: 30 },
      });

      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.events)) {
          const events: ScheduleHistoryEvent[] = data.events
            .map((e: Record<string, unknown>) => {
              const type = normalizeEventType(String(e.event_type || e.type || ""));
              const closedAtStr = String(e.ledger_closed_at || "");
              const timestamp = closedAtStr ? Math.floor(new Date(closedAtStr).getTime() / 1000) : Number(e.timestamp || 0);

              return {
                id: String(e.id || `evt-${scheduleId}-${type}`),
                type,
                schedule_id: scheduleId,
                timestamp,
                ledger: e.ledger ? Number(e.ledger) : undefined,
                actor: (e.grantor || e.beneficiary || e.actor || null) as string | null,
                grantor: (e.grantor || null) as string | null,
                beneficiary: (e.beneficiary || null) as string | null,
                amount: e.amount ? String(e.amount) : (e.created_amount ? String(e.created_amount) : null),
                token: (e.token || null) as string | null,
              };
            })
            .sort((a: ScheduleHistoryEvent, b: ScheduleHistoryEvent) => a.timestamp - b.timestamp);

          return NextResponse.json(
            {
              schedule_id: scheduleId,
              events,
              total: events.length,
              network,
            },
            {
              headers: {
                "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
              },
            }
          );
        }
      }
    } catch {
      // Fall through to on-chain fallback
    }

    // Fallback: Query schedule state from Stellar contract simulation
    const schedule = await getSchedule(scheduleId);
    if (!schedule) {
      return NextResponse.json(
        { error: "Schedule not found" },
        { status: 404 }
      );
    }

    const events: ScheduleHistoryEvent[] = [
      {
        id: `created-${schedule.id}`,
        type: "created",
        schedule_id: schedule.id,
        timestamp: schedule.start_time,
        actor: schedule.grantor,
        grantor: schedule.grantor,
        beneficiary: schedule.beneficiary,
        amount: schedule.total_amount.toString(),
        token: schedule.token,
      },
    ];

    if (schedule.claimed > 0n) {
      events.push({
        id: `claimed-${schedule.id}`,
        type: "claimed",
        schedule_id: schedule.id,
        timestamp: schedule.start_time,
        actor: schedule.beneficiary,
        grantor: schedule.grantor,
        beneficiary: schedule.beneficiary,
        amount: schedule.claimed.toString(),
        token: schedule.token,
      });
    }

    if (schedule.revoked) {
      events.push({
        id: `revoked-${schedule.id}`,
        type: "revoked",
        schedule_id: schedule.id,
        timestamp: schedule.start_time,
        actor: schedule.grantor,
        grantor: schedule.grantor,
        beneficiary: schedule.beneficiary,
        amount: schedule.vested_at_revoke.toString(),
        token: schedule.token,
      });
    }

    if (schedule.paused) {
      events.push({
        id: `paused-${schedule.id}`,
        type: "paused",
        schedule_id: schedule.id,
        timestamp: schedule.start_time,
        actor: schedule.grantor,
        grantor: schedule.grantor,
        beneficiary: schedule.beneficiary,
        token: schedule.token,
      });
    }

    events.sort((a, b) => a.timestamp - b.timestamp);

    return NextResponse.json(
      {
        schedule_id: scheduleId,
        events,
        total: events.length,
        network,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching schedule history:", error);
    return NextResponse.json(
      { error: "Failed to fetch schedule history" },
      { status: 500 }
    );
  }
});
