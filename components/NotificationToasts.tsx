"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useNotifications } from "@/lib/notifications-context";
import { notificationTitle, visualFor } from "@/lib/notifications";
import {
  dismissToast,
  emptyQueue,
  pushToast,
  type NotificationToast,
  type ToastQueueState,
} from "@/lib/toast-queue";

const AUTO_DISMISS_MS = 5000;

const COLOR_CLASSES: Record<string, { border: string; bg: string; text: string }> = {
  teal: { border: "border-teal-500/40", bg: "bg-teal-500/5", text: "text-teal-300" },
  blue: { border: "border-blue-500/40", bg: "bg-blue-500/5", text: "text-blue-300" },
  green: { border: "border-green-500/40", bg: "bg-green-500/5", text: "text-green-300" },
  red: { border: "border-red-500/40", bg: "bg-red-500/5", text: "text-red-300" },
  amber: { border: "border-amber-500/40", bg: "bg-amber-500/5", text: "text-amber-300" },
  zinc: { border: "border-zinc-500/40", bg: "bg-zinc-500/5", text: "text-zinc-300" },
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const handler = () => setReduced(query.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function queueReducer(state: ToastQueueState, action: { type: "push"; toast: NotificationToast } | { type: "dismiss"; id: number }): ToastQueueState {
  if (action.type === "push") return pushToast(state, action.toast);
  return dismissToast(state, action.id);
}

function NotificationToastItem({
  toast,
  reducedMotion,
  onDismiss,
}: {
  toast: NotificationToast;
  reducedMotion: boolean;
  onDismiss: (id: number) => void;
}) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const scheduleDismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => dismiss(), AUTO_DISMISS_MS);
  };

  // Auto-dismiss after 5s; the timer resets while the user hovers.
  useEffect(() => {
    scheduleDismiss();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
    if (reducedMotion) {
      onDismiss(toast.id);
    } else {
      setTimeout(() => onDismiss(toast.id), 300);
    }
  };

  const visual = visualFor(toast.event_type);
  const colors = COLOR_CLASSES[visual.color] ?? COLOR_CLASSES.zinc;

  return (
    <div
      role="alert"
      aria-live="assertive"
      onMouseEnter={() => {
        if (timerRef.current) clearTimeout(timerRef.current);
      }}
      onMouseLeave={scheduleDismiss}
      className={`
        relative flex items-start gap-3 rounded-xl border px-4 py-3 shadow-xl backdrop-blur-md
        max-w-sm w-full ${colors.border} ${colors.bg}
        ${reducedMotion ? "" : "transition-all duration-300 ease-out"}
        ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}
      `}
    >
      <div className="mt-0.5 shrink-0 text-base leading-none" aria-hidden="true">
        {visual.icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold leading-snug ${colors.text}`}>{toast.title}</p>
        <p className="text-xs text-zinc-400 mt-0.5">{visual.label}</p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss notification"
        className="shrink-0 text-zinc-500 hover:text-white transition-colors leading-none mt-0.5"
      >
        ×
      </button>
    </div>
  );
}

/**
 * Real-time notification toasts. Subscribes to the SharedWorker's live stream
 * via the notification context and renders at most 3 toasts at once, queueing
 * the overflow until a slot frees.
 */
export default function NotificationToasts() {
  const { subscribe } = useNotifications();
  const [state, dispatch] = useReducer(queueReducer, emptyQueue);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    return subscribe((notification) => {
      dispatch({
        type: "push",
        toast: {
          id: notification.id,
          event_type: notification.event_type,
          title: notificationTitle(notification),
        },
      });
    });
  }, [subscribe]);

  if (state.visible.length === 0) return null;

  return (
    <div
      aria-label="Notifications"
      className="fixed top-20 right-5 left-5 sm:left-auto z-[9998] flex flex-col gap-2 items-end pointer-events-none"
    >
      {state.visible.map((toast) => (
        <div key={toast.id} className="pointer-events-auto w-full sm:w-auto">
          <NotificationToastItem
            toast={toast}
            reducedMotion={reducedMotion}
            onDismiss={(id) => dispatch({ type: "dismiss", id })}
          />
        </div>
      ))}
    </div>
  );
}
