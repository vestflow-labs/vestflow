import webPush from "web-push";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:noreply@vestflow.xyz";

let isConfigured = false;

function configureVapid(): void {
  if (isConfigured || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  isConfigured = true;
}

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
}

export async function sendPushNotification(
  subscription: PushSubscription,
  payload: PushNotificationPayload
): Promise<boolean> {
  configureVapid();
  if (!isConfigured) {
    console.warn("VAPID keys not configured. Push notification not sent.");
    return false;
  }

  try {
    await webPush.sendNotification(
      subscription,
      JSON.stringify(payload),
      { TTL: 60 * 60 }
    );
    return true;
  } catch (error: unknown) {
    const err = error as { statusCode?: number };
    if (err.statusCode === 404 || err.statusCode === 410) {
      console.warn("Push subscription expired or invalid:", subscription.endpoint);
    } else {
      console.error("Push notification failed:", error);
    }
    return false;
  }
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export function isWebPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}
