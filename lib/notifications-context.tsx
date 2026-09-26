"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWallet } from "./WalletContext";
import { getStoredToken } from "./auth";
import type { AppNotification, WorkerMessage, WorkerRequest } from "./notifications";

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:3001";
const WORKER_URL = "/workers/sse.worker.js";
const LAST_EVENT_ID_KEY = "vestflow-notifications-last-event-id";

interface NotificationCtx {
  unread: number;
  markRead: (ids: number[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** Subscribe to live notifications (drives the toast queue). */
  subscribe: (fn: (notification: AppNotification) => void) => () => void;
}

const NotificationContext = createContext<NotificationCtx>({
  unread: 0,
  markRead: async () => {},
  markAllRead: async () => {},
  subscribe: () => () => {},
});

export function useNotifications(): NotificationCtx {
  return useContext(NotificationContext);
}

function readLastEventId(): number | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(LAST_EVENT_ID_KEY);
  if (!stored) return null;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : null;
}

function persistLastEventId(id: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAST_EVENT_ID_KEY, String(id));
  } catch {
    // Ignore storage failures.
  }
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { publicKey } = useWallet();
  const [unread, setUnread] = useState(0);
  const [token, setToken] = useState<string | null>(null);

  const workerRef = useRef<SharedWorker | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const listenersRef = useRef<Set<(n: AppNotification) => void>>(new Set());
  const unreadRef = useRef(0);

  useEffect(() => {
    unreadRef.current = unread;
  }, [unread]);

  // ── Detect the auth token (written by WalletAuthButton after signing) ──
  useEffect(() => {
    const read = () => setToken(getStoredToken());
    read();
    const id = setInterval(read, 2000);
    return () => clearInterval(id);
  }, [publicKey]);

  const subscribe = useCallback((fn: (n: AppNotification) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const markRead = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return;
      portRef.current?.postMessage({ type: "MARK_READ", ids } satisfies WorkerRequest);
      try {
        await fetch("/api/notifications/read", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token ?? ""}`,
          },
          body: JSON.stringify({ event_ids: ids }),
        });
      } catch {
        // The worker already optimistically cleared the badge; the server
        // write is best-effort here.
      }
    },
    [token],
  );

  const markAllRead = useCallback(async () => {
    portRef.current?.postMessage({ type: "MARK_ALL_READ" } satisfies WorkerRequest);
    try {
      await fetch("/api/notifications/read-all", {
        method: "POST",
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
    } catch {
      // Best-effort.
    }
  }, [token]);

  // ── Worker lifecycle ─────────────────────────────────────────────────
  useEffect(() => {
    if (!token || !publicKey) return;

    let worker: SharedWorker | null = null;
    let port: MessagePort | null = null;

    const onMessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "NOTIFICATION": {
          persistLastEventId(message.notification.id);
          for (const listener of listenersRef.current) {
            listener(message.notification);
          }
          break;
        }
        case "UNREAD":
          setUnread(message.count);
          break;
        case "BACKFILL":
        case "CONNECTED":
        case "ERROR":
          break;
      }
    };

    try {
      worker = new SharedWorker(WORKER_URL);
      port = worker.port;
      workerRef.current = worker;
      portRef.current = port;
      port.onmessage = onMessage;
      port.start();

      port.postMessage({
        type: "CONNECT",
        wallet: publicKey,
        token,
        url: `${INDEXER_URL}/events/stream`,
        lastEventId: readLastEventId(),
        unread: unreadRef.current,
      } satisfies WorkerRequest);
    } catch {
      // SharedWorker unavailable (older browsers) — notifications silently
      // degrade to the notification center's polling/refresh flow.
      return;
    }

    return () => {
      try {
        port?.postMessage({ type: "DISCONNECT" } satisfies WorkerRequest);
        worker?.port.close();
      } catch {
        // Ignore.
      }
      workerRef.current = null;
      portRef.current = null;
    };
  }, [token, publicKey]);

  return (
    <NotificationContext.Provider value={{ unread, markRead, markAllRead, subscribe }}>
      {children}
    </NotificationContext.Provider>
  );
}
