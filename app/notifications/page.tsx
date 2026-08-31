"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Navbar from "@/components/Navbar";
import { useNotifications } from "@/lib/notifications-context";
import { getStoredToken } from "@/lib/auth";
import {
  NOTIFICATION_EVENT_TYPES,
  notificationTitle,
  parseNotificationPayload,
  visualFor,
  type AppNotification,
} from "@/lib/notifications";

const PAGE_SIZE = 50;

type ReadFilter = "all" | "unread" | "read";

interface NotificationsResponse {
  notifications: AppNotification[];
  page: number;
  limit: number;
  total: number;
  unread: number;
}

const COLOR_CLASSES: Record<string, string> = {
  teal: "border-teal-500/40 bg-teal-500/5 text-teal-300",
  blue: "border-blue-500/40 bg-blue-500/5 text-blue-300",
  green: "border-green-500/40 bg-green-500/5 text-green-300",
  red: "border-red-500/40 bg-red-500/5 text-red-300",
  amber: "border-amber-500/40 bg-amber-500/5 text-amber-300",
  zinc: "border-zinc-500/40 bg-zinc-500/5 text-zinc-300",
};

export default function NotificationsPage() {
  const { markAllRead, markRead } = useNotifications();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");

  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  const load = useCallback(async () => {
    setLoading(true);
    const token = getStoredToken();
    if (!token) {
      setNotifications([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (selectedTypes.size > 0) {
        params.set("type", [...selectedTypes].join(","));
      }
      if (readFilter !== "all") {
        params.set("read", readFilter === "read" ? "1" : "0");
      }

      const res = await fetch(`/api/notifications?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as NotificationsResponse;
      setNotifications(data.notifications ?? []);
      setTotal(data.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [page, selectedTypes, readFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleType = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
    setPage(1);
  };

  const handleMarkAllRead = async () => {
    await markAllRead();
    setNotifications((prev) => prev.map((n) => ({ ...n, read: 1 })));
  };

  const handleMarkRead = async (notification: AppNotification) => {
    if (notification.read) return;
    await markRead([notification.id]);
    setNotifications((prev) =>
      prev.map((n) => (n.id === notification.id ? { ...n, read: 1 } : n)),
    );
  };

  const message = useMemo(() => {
    const fn = (n: AppNotification) => {
      const payload = parseNotificationPayload(n);
      if (!payload) return "";
      const parts: string[] = [];
      if (payload.amount) parts.push(`${payload.amount} stroops`);
      if (payload.ledger) parts.push(`ledger ${payload.ledger}`);
      return parts.join(" · ");
    };
    return fn;
  }, []);

  return (
    <>
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold">Notifications</h1>
            <p className="text-zinc-400 mt-1">Real-time activity for your wallets</p>
          </div>
          <button
            onClick={handleMarkAllRead}
            className="text-sm px-3 py-2 border border-white/10 rounded-lg hover:border-white/20 transition-colors text-zinc-300 hover:text-white"
          >
            Mark all as read
          </button>
        </div>

        {/* Event-type multi-select */}
        <div className="flex flex-wrap gap-2 mb-4">
          {NOTIFICATION_EVENT_TYPES.map((type) => {
            const active = selectedTypes.has(type);
            const colors = COLOR_CLASSES[visualFor(type).color] ?? COLOR_CLASSES.zinc;
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                aria-pressed={active}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  active
                    ? colors
                    : "border-white/10 text-zinc-400 hover:text-white hover:border-white/20"
                }`}
              >
                {visualFor(type).icon} {visualFor(type).label}
              </button>
            );
          })}
        </div>

        {/* Read/unread filter */}
        <div className="flex gap-2 mb-6">
          {(["all", "unread", "read"] as ReadFilter[]).map((filter) => (
            <button
              key={filter}
              onClick={() => {
                setReadFilter(filter);
                setPage(1);
              }}
              aria-pressed={readFilter === filter}
              className={`text-xs px-3 py-1.5 rounded-lg border capitalize transition-colors ${
                readFilter === filter
                  ? "border-violet-500/50 bg-violet-600/20 text-violet-300"
                  : "border-white/10 text-zinc-400 hover:text-white"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* List */}
        {loading ? (
          <p className="text-zinc-500 text-sm">Loading…</p>
        ) : notifications.length === 0 ? (
          <div className="border border-white/10 rounded-xl p-10 text-center">
            <p className="text-zinc-400">No notifications</p>
            <p className="text-zinc-600 text-sm mt-1">
              New events will appear here in real time.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {notifications.map((n) => {
              const visual = visualFor(n.event_type);
              const colors = COLOR_CLASSES[visual.color] ?? COLOR_CLASSES.zinc;
              return (
                <li key={n.id}>
                  <button
                    onClick={() => handleMarkRead(n)}
                    className={`w-full text-left flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                      n.read ? "border-white/5 bg-transparent opacity-60" : `${colors}`
                    }`}
                  >
                    <span className="mt-0.5 text-base leading-none" aria-hidden="true">
                      {visual.icon}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2">
                        <span className={`text-sm font-semibold ${n.read ? "text-zinc-400" : "text-white"}`}>
                          {notificationTitle(n)}
                        </span>
                        {!n.read && (
                          <span className="inline-block w-2 h-2 rounded-full bg-violet-500 shrink-0" aria-label="unread" />
                        )}
                      </span>
                      {message(n) && (
                        <span className="block text-xs text-zinc-500 mt-0.5">{message(n)}</span>
                      )}
                      <span className="block text-xs text-zinc-600 mt-0.5">
                        {new Date(n.created_at * 1000).toLocaleString()}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 mt-6">
            <button
              onClick={() => setPage((p) => Math.max(p - 1, 1))}
              disabled={page <= 1}
              className="text-sm px-3 py-1.5 border border-white/10 rounded-lg disabled:opacity-40 text-zinc-300"
            >
              Previous
            </button>
            <span className="text-sm text-zinc-500">
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
              disabled={page >= totalPages}
              className="text-sm px-3 py-1.5 border border-white/10 rounded-lg disabled:opacity-40 text-zinc-300"
            >
              Next
            </button>
          </div>
        )}
      </main>
    </>
  );
}
