"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { NATIVE_TOKEN, NETWORK, stroopsToXlm } from "@/lib/stellar";

interface ActivityEvent {
  id: string;
  event_type: string;
  ledger: number;
  ledger_closed_at: string;
  grantor?: string | null;
  beneficiary?: string | null;
  amount?: string | null;
  token?: string | null;
  schedule_id?: number | null;
}

function tokenLabel(token: string): string {
  if (token === NATIVE_TOKEN) return "XLM";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

function formatEventDescription(event: ActivityEvent, publicKey: string): string {
  const amount = event.amount ? stroopsToXlm(BigInt(event.amount)) : "0";
  const token = tokenLabel(event.token ?? NATIVE_TOKEN);
  const isGrantor = event.grantor === publicKey;
  const isCollector = event.event_type === "collected" && event.beneficiary === publicKey;

  switch (event.event_type) {
    case "given":
      return isGrantor ? `Sent ${amount} ${token}` : `Received ${amount} ${token}`;
    case "collected":
      return `Collected ${amount} ${token}`;
    case "schedule_created":
      return isGrantor ? "Created new stream" : "Added as beneficiary";
    case "revoked":
      return "Stream revoked";
    default:
      return "Stream activity";
  }
}

function getEventIcon(event: ActivityEvent): string {
  switch (event.event_type) {
    case "given":
      return "→";
    case "collected":
      return "✓";
    case "schedule_created":
      return "+";
    case "revoked":
      return "✕";
    default:
      return "•";
  }
}

function getEventColor(event: ActivityEvent, publicKey: string): string {
  switch (event.event_type) {
    case "given":
      return event.grantor === publicKey ? "text-red-400" : "text-emerald-400";
    case "collected":
      return "text-emerald-400";
    case "schedule_created":
      return "text-violet-400";
    case "revoked":
      return "text-red-500";
    default:
      return "text-zinc-400";
  }
}

interface ActivityFeedProps {
  publicKey: string;
  refreshKey: number;
}

export default function ActivityFeed({ publicKey, refreshKey }: ActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/events?address=${publicKey}&network=${NETWORK}&limit=10&offset=0`);
      if (!res.ok) {
        setEvents([]);
        return;
      }
      const data = await res.json();
      const eventList = (data.events ?? []) as ActivityEvent[];
      setEvents(eventList);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents, refreshKey]);

  useEffect(() => {
    const interval = setInterval(fetchEvents, 30000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  if (loading) {
    return (
      <div className="card p-5 mb-6">
        <p className="text-sm text-zinc-400">Loading activity feed...</p>
      </div>
    );
  }

  if (events.length === 0) return null;

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold">Recent Activity</h2>
          <p className="text-sm text-zinc-500">Latest stream-related events</p>
        </div>
        <button
          onClick={fetchEvents}
          disabled={loading}
          className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 min-h-[44px] transition-colors disabled:opacity-40 inline-flex items-center"
          aria-label="Refresh activity feed"
        >
          ↻
        </button>
      </div>
      <div className="divide-y divide-white/10 space-y-0">
        {events.map((event) => {
          const counterparty = event.grantor === publicKey ? event.beneficiary : event.grantor;
          const timeAgo = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(
            Math.floor((new Date(event.ledger_closed_at).getTime() - Date.now()) / 1000),
            'second'
          );

          return (
            <div key={event.id} className="flex items-start gap-3 py-3 text-sm">
              <span className={`text-lg shrink-0 ${getEventColor(event, publicKey)}`}>
                {getEventIcon(event)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-zinc-200">
                  {formatEventDescription(event, publicKey)}
                </p>
                {counterparty && (
                  <Link
                    href={`/profile/${encodeURIComponent(counterparty)}`}
                    className="text-xs text-zinc-500 hover:text-violet-300 transition-colors"
                  >
                    {truncateAddress(counterparty)}
                  </Link>
                )}
              </div>
              <time className="text-xs text-zinc-500 whitespace-nowrap shrink-0" dateTime={event.ledger_closed_at}>
                {timeAgo}
              </time>
            </div>
          );
        })}
      </div>
    </div>
  );
}
