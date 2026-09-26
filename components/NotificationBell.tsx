"use client";

import Link from "next/link";
import { useNotifications } from "@/lib/notifications-context";

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/**
 * Nav notification bell. The unread count is driven live by the SharedWorker
 * (via the notification context) so it updates across tabs without a refresh.
 */
export default function NotificationBell() {
  const { unread } = useNotifications();

  return (
    <Link
      href="/notifications"
      aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
      className="relative text-zinc-400 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-white/5 flex items-center justify-center"
    >
      <BellIcon />
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-violet-600 text-white text-[10px] font-semibold flex items-center justify-center leading-none">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
