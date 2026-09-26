/**
 * VestFlow — real-time notification SharedWorker.
 *
 * Every tab on the same origin shares a single worker instance, and therefore
 * a single SSE connection to the indexer. The worker:
 *
 *   - maintains an in-memory buffer of the most recent notifications (FIFO, 100),
 *   - broadcasts each new SSE event to every connected port,
 *   - backfills a newly-connected tab with the buffered notifications,
 *   - tears down the SSE connection when the last tab disconnects,
 *   - reconnects with exponential backoff (1s → 2s → 4s → 8s, capped at 30s)
 *     and resumes with `Last-Event-ID` so no event is lost while a tab sleeps.
 */

import {
  backoffDelayMs,
  type AppNotification,
  type WorkerMessage,
  type WorkerRequest,
} from "../lib/notifications";

interface SharedWorkerScope {
  onconnect: ((e: MessageEvent) => void) | null;
}

interface MessagePortLike {
  postMessage(message: WorkerMessage): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
}

const ctx = self as unknown as SharedWorkerScope;

const MAX_BUFFER = 100;

const ports = new Set<MessagePortLike>();
const buffer: AppNotification[] = [];
const bufferIds = new Set<number>();

let unread = 0;
let wallet: string | null = null;
let token: string | null = null;
let streamUrl: string | null = null;
let lastEventId: number | null = null;

let controller: AbortController | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast(message: WorkerMessage): void {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      // Ignore ports that are mid-close.
    }
  }
}

function pushToBuffer(notification: AppNotification): void {
  if (bufferIds.has(notification.id)) return;
  buffer.push(notification);
  bufferIds.add(notification.id);
  while (buffer.length > MAX_BUFFER) {
    const evicted = buffer.shift();
    if (evicted) bufferIds.delete(evicted.id);
  }
}

function nextBackoffMs(): number {
  return backoffDelayMs(reconnectAttempts);
}

function closeStream(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  controller?.abort();
  controller = null;
}

function scheduleReconnect(): void {
  if (!wallet || !token || !streamUrl) return;
  if (reconnectTimer) return;

  const delay = nextBackoffMs();
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectStream();
  }, delay);
}

/** Parses an SSE frame into { id, data } or null for comments/heartbeats. */
function parseFrame(frame: string): { id: string | null; data: string | null } | null {
  if (frame.trim().length === 0) return null;

  let id: string | null = null;
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  return { id, data: dataLines.join("\n") };
}

function handleFrame(frame: string): void {
  const parsed = parseFrame(frame);
  if (!parsed) return;

  let notification: AppNotification;
  try {
    notification = JSON.parse(parsed.data ?? "") as AppNotification;
  } catch {
    return;
  }

  if (typeof notification.id !== "number") return;
  if (parsed.id) lastEventId = Number(parsed.id);

  if (!bufferIds.has(notification.id)) {
    pushToBuffer(notification);
    unread++;
    broadcast({ type: "UNREAD", count: unread });
  }
  broadcast({ type: "NOTIFICATION", notification });
}

async function connectStream(): Promise<void> {
  if (!wallet || !token || !streamUrl) return;

  const url = new URL(streamUrl);
  url.searchParams.set("wallet", wallet);

  controller = new AbortController();
  const signal = controller.signal;

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(lastEventId != null ? { "Last-Event-ID": String(lastEventId) } : {}),
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`SSE responded ${response.status}`);
    }
    if (!response.body) {
      throw new Error("SSE response had no body");
    }

    reconnectAttempts = 0;
    broadcast({ type: "CONNECTED" });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";

      for (const frame of frames) {
        handleFrame(frame);
      }
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      broadcast({ type: "ERROR", message: (error as Error).message });
    }
  }

  controller = null;
  if (ports.size > 0) scheduleReconnect();
}

function handleRequest(port: MessagePortLike, request: WorkerRequest): void {
  switch (request.type) {
    case "CONNECT": {
      const changed =
        wallet !== request.wallet ||
        token !== request.token ||
        streamUrl !== request.url;

      wallet = request.wallet;
      token = request.token;
      streamUrl = request.url;
      lastEventId = request.lastEventId;
      unread = request.unread;

      if (changed || !controller) {
        closeStream();
        void connectStream();
      }
      port.postMessage({ type: "UNREAD", count: unread });
      port.postMessage({ type: "BACKFILL", notifications: [...buffer] });
      break;
    }
    case "MARK_READ": {
      let cleared = 0;
      for (const id of request.ids) {
        if (bufferIds.has(id)) cleared++;
      }
      unread = Math.max(unread - cleared, 0);
      broadcast({ type: "UNREAD", count: unread });
      break;
    }
    case "MARK_ALL_READ": {
      unread = 0;
      broadcast({ type: "UNREAD", count: unread });
      break;
    }
    case "SET_UNREAD": {
      unread = request.count;
      broadcast({ type: "UNREAD", count: unread });
      break;
    }
    case "DISCONNECT": {
      ports.delete(port);
      if (ports.size === 0) closeStream();
      break;
    }
  }
}

ctx.onconnect = (event: MessageEvent) => {
  const port = event.ports[0] as unknown as MessagePortLike;
  ports.add(port);

  // Backfill a newly-connected tab with the current buffered state.
  port.postMessage({ type: "BACKFILL", notifications: [...buffer] });
  port.postMessage({ type: "UNREAD", count: unread });

  port.onmessage = (e: MessageEvent<WorkerRequest>) => {
    handleRequest(port, e.data);
  };
};
