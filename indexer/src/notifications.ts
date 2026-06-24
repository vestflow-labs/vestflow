import {
  getSubscriptionsBySchedule,
  recordNotificationEvent,
  hasMilestoneBeenProcessed,
  markMilestoneProcessed,
} from "./db";
import {
  sendCliffReachedNotification,
  sendClaimableNotification,
  sendRevokedNotification,
} from "./email";
import { getSchedule, getClaimable } from "./stellar";

export async function processNotifications(): Promise<void> {
  try {
    console.log("Processing notifications...");
    
  } catch (error) {
    console.error("Error processing notifications:", error);
  }
}

export async function checkAndSendCliffNotification(
  scheduleId: number
): Promise<void> {
  if (hasMilestoneBeenProcessed(scheduleId, "cliff_reached")) {
    return;
  }

  try {
    const schedule = await getSchedule(scheduleId);
    if (!schedule) {
      console.warn(`Schedule ${scheduleId} not found`);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const cliffTime = schedule.start_time + (schedule.cliff_duration || 0);

    if (schedule.cliff_duration && now >= cliffTime && !schedule.revoked) {
      const subscriptions = getSubscriptionsBySchedule(scheduleId);

      for (const sub of subscriptions) {
        if (
          sub.notification_type === "cliff_reached" ||
          sub.notification_type === "all"
        ) {
          try {
            await sendCliffReachedNotification(
              sub.email,
              scheduleId,
              sub.beneficiary_address,
              new Date(cliffTime * 1000)
            );
            recordNotificationEvent(
              sub.id,
              "cliff_reached",
              scheduleId,
              "sent"
            );
          } catch (error) {
            console.error(
              `Failed to send cliff notification to ${sub.email}:`,
              error
            );
            recordNotificationEvent(
              sub.id,
              "cliff_reached",
              scheduleId,
              "failed",
              String(error)
            );
          }
        }
      }

      markMilestoneProcessed(scheduleId, "cliff_reached");
    }
  } catch (error) {
    console.error(`Error checking cliff notification for schedule ${scheduleId}:`, error);
  }
}

export async function checkAndSendClaimableNotification(
  scheduleId: number
): Promise<void> {
  if (hasMilestoneBeenProcessed(scheduleId, "fully_vested")) {
    return;
  }

  try {
    const schedule = await getSchedule(scheduleId);
    if (!schedule) {
      console.warn(`Schedule ${scheduleId} not found`);
      return;
    }

    const claimable = await getClaimable(scheduleId);
    const now = Math.floor(Date.now() / 1000);
    const endTime = schedule.start_time + schedule.duration;

    if (claimable > 0n && now >= schedule.start_time && !schedule.revoked) {
      const subscriptions = getSubscriptionsBySchedule(scheduleId);
      const claimableXLM = (
        Number(claimable) / 10_000_000
      ).toLocaleString("en-US", {
        maximumFractionDigits: 7,
        minimumFractionDigits: 2,
      });

      for (const sub of subscriptions) {
        if (
          sub.notification_type === "claimable" ||
          sub.notification_type === "all"
        ) {
          try {
            await sendClaimableNotification(
              sub.email,
              scheduleId,
              claimableXLM,
              new Date()
            );
            recordNotificationEvent(
              sub.id,
              "claimable",
              scheduleId,
              "sent"
            );
          } catch (error) {
            console.error(
              `Failed to send claimable notification to ${sub.email}:`,
              error
            );
            recordNotificationEvent(
              sub.id,
              "claimable",
              scheduleId,
              "failed",
              String(error)
            );
          }
        }
      }

      markMilestoneProcessed(scheduleId, "fully_vested");
    }
  } catch (error) {
    console.error(
      `Error checking claimable notification for schedule ${scheduleId}:`,
      error
    );
  }
}

export async function checkAndSendRevokedNotification(
  scheduleId: number
): Promise<void> {
  if (hasMilestoneBeenProcessed(scheduleId, "revoked")) {
    return;
  }

  try {
    const schedule = await getSchedule(scheduleId);
    if (!schedule) {
      console.warn(`Schedule ${scheduleId} not found`);
      return;
    }

    if (schedule.revoked) {
      const subscriptions = getSubscriptionsBySchedule(scheduleId);

      for (const sub of subscriptions) {
        if (
          sub.notification_type === "revoked" ||
          sub.notification_type === "all"
        ) {
          try {
            await sendRevokedNotification(
              sub.email,
              scheduleId,
              new Date()
            );
            recordNotificationEvent(
              sub.id,
              "revoked",
              scheduleId,
              "sent"
            );
          } catch (error) {
            console.error(
              `Failed to send revoked notification to ${sub.email}:`,
              error
            );
            recordNotificationEvent(
              sub.id,
              "revoked",
              scheduleId,
              "failed",
              String(error)
            );
          }
        }
      }

      markMilestoneProcessed(scheduleId, "revoked");
    }
  } catch (error) {
    console.error(
      `Error checking revoked notification for schedule ${scheduleId}:`,
      error
    );
  }
}
