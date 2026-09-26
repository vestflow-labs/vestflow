"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";
import { ScheduleData, NETWORK, stroopsToXlm } from "@/lib/stellar";

const NOTIFICATION_STORAGE_KEY = "vestflow-stream-notifications";
const NOTIFICATION_DISMISS_WINDOW = 24 * 60 * 60 * 1000; // 24 hours in ms
const STREAM_WARNING_THRESHOLD = 7 * 24 * 60 * 60; // 7 days in seconds

type NotificationRecord = Record<number, number>; // scheduleId -> timestamp of last dismissed

function getNotificationRecord(): NotificationRecord {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(NOTIFICATION_STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveNotificationRecord(record: NotificationRecord): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(record));
}

function shouldShowNotification(scheduleId: number, lastDismissedAt: number | undefined): boolean {
  if (!lastDismissedAt) return true;
  const now = Date.now();
  return now - lastDismissedAt >= NOTIFICATION_DISMISS_WINDOW;
}

/**
 * Hook to monitor incoming streams and show notifications when the sender's
 * stream will run out within 7 days. Notifications are dismissible and re-show
 * after 24 hours if still within the threshold.
 */
export function useStreamNotifications(schedules: ScheduleData[] | null, publicKey: string | null) {
  const { addToast } = useToast();
  const processedRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!publicKey || !schedules || schedules.length === 0) return;

    const now = Math.floor(Date.now() / 1000);
    const record = getNotificationRecord();

    // Find incoming streams where the sender's stream will run out within 7 days
    schedules.forEach((schedule) => {
      // Only process incoming streams (user is beneficiary)
      if (schedule.beneficiary !== publicKey || schedule.revoked) return;

      // Already processed in this session
      if (processedRef.current.has(schedule.id)) return;

      const endTime = schedule.start_time + schedule.duration;
      const secondsUntilEnd = endTime - now;

      // Check if stream will end within 7 days
      if (secondsUntilEnd > 0 && secondsUntilEnd <= STREAM_WARNING_THRESHOLD) {
        const lastDismissed = record[schedule.id];
        if (shouldShowNotification(schedule.id, lastDismissed)) {
          // Calculate estimated stop date
          const stopDate = new Date(endTime * 1000).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: endTime > Date.now() / 1000 + 365 * 24 * 60 * 60 ? "numeric" : undefined,
          });

          const daysLeft = Math.ceil(secondsUntilEnd / (24 * 60 * 60));
          const senderAddr = schedule.grantor.slice(0, 6) + "..." + schedule.grantor.slice(-4);

          addToast({
            status: "info",
            title: `Stream ending soon`,
            message: `Stream from ${senderAddr} will stop in ${daysLeft} day${daysLeft !== 1 ? "s" : ""} (${stopDate}). Reach out before it runs out.`,
            duration: 0, // Don't auto-dismiss
          });

          // Mark as processed in this session and update last dismissed time
          processedRef.current.add(schedule.id);
          record[schedule.id] = Date.now();
          saveNotificationRecord(record);
        }
      }
    });
  }, [schedules, publicKey, addToast]);
}
