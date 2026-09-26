import type { IncomingMessage } from "http";
import type { Socket } from "net";

interface InFlightRequest {
  socket: Socket;
  timestamp: number;
}

let inFlightRequests = new Set<InFlightRequest>();
let isShuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = parseInt(
  process.env.SHUTDOWN_TIMEOUT_MS || "10000",
  10
);

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Set up graceful shutdown handlers
    const signalHandler = (signal: string) => {
      console.log(
        `[${new Date().toISOString()}] Received ${signal}, starting graceful shutdown...`
      );
      isShuttingDown = true;

      const shutdownTimeout = setTimeout(() => {
        console.warn(
          `[${new Date().toISOString()}] Shutdown timeout reached (${SHUTDOWN_TIMEOUT_MS}ms). Forcing exit with ${inFlightRequests.size} in-flight requests.`
        );
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      const checkInterval = setInterval(() => {
        console.log(
          `[${new Date().toISOString()}] In-flight requests: ${inFlightRequests.size}`
        );
        if (inFlightRequests.size === 0) {
          clearInterval(checkInterval);
          clearTimeout(shutdownTimeout);
          console.log(
            `[${new Date().toISOString()}] All requests completed. Exiting gracefully.`
          );
          process.exit(0);
        }
      }, 1000);
    };

    process.on("SIGTERM", () => signalHandler("SIGTERM"));
    process.on("SIGINT", () => signalHandler("SIGINT"));

    console.log(
      `[${new Date().toISOString()}] Graceful shutdown handler registered (timeout: ${SHUTDOWN_TIMEOUT_MS}ms)`
    );
  }
}

export function isServerShuttingDown(): boolean {
  return isShuttingDown;
}

export function registerInFlightRequest(req: IncomingMessage): void {
  if (req.socket) {
    const inFlightReq: InFlightRequest = {
      socket: req.socket,
      timestamp: Date.now(),
    };
    inFlightRequests.add(inFlightReq);

    const cleanup = () => {
      inFlightRequests.delete(inFlightReq);
    };

    req.on("end", cleanup);
    req.on("close", cleanup);
    req.on("error", cleanup);
  }
}
