import http from "http";
import { createServer } from "http";
import { parse } from "url";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const SHUTDOWN_TIMEOUT_MS = parseInt(
  process.env.SHUTDOWN_TIMEOUT_MS || "10000",
  10
);

interface InFlightRequests {
  count: number;
  requests: Set<http.ClientRequest>;
}

const inFlightRequests: InFlightRequests = {
  count: 0,
  requests: new Set(),
};

let isShuttingDown = false;

function trackRequest(req: http.IncomingMessage): void {
  const reqWithSocket = req.socket;
  if (reqWithSocket) {
    inFlightRequests.count++;
    inFlightRequests.requests.add(
      req as unknown as http.ClientRequest
    );

    req.on("end", () => {
      inFlightRequests.requests.delete(
        req as unknown as http.ClientRequest
      );
      inFlightRequests.count--;
    });

    req.on("close", () => {
      inFlightRequests.requests.delete(
        req as unknown as http.ClientRequest
      );
      inFlightRequests.count--;
    });
  }
}

async function startServer(): Promise<void> {
  await app.prepare();

  const server = createServer(async (req, res) => {
    if (isShuttingDown) {
      res.writeHead(503, {
        "Content-Type": "application/problem+json",
        Retry: "1",
      });
      res.end(
        JSON.stringify({
          type: "https://api.vestflow.dev/errors/service-unavailable",
          title: "Service Unavailable",
          status: 503,
          detail: "Server is shutting down",
          instance: `${req.url}`,
        })
      );
      return;
    }

    trackRequest(req);

    try {
      const parsedUrl = parse(req.url || "", true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error handling request:", err);
      if (!res.writableEnded) {
        res.writeHead(500, {
          "Content-Type": "application/problem+json",
        });
        res.end(
          JSON.stringify({
            type: "https://api.vestflow.dev/errors/internal-server-error",
            title: "Internal Server Error",
            status: 500,
            detail: "An unexpected error occurred",
            instance: `${req.url}`,
          })
        );
      }
    }
  });

  function gracefulShutdown(signal: string): void {
    console.log(`\n[${new Date().toISOString()}] Received ${signal}, starting graceful shutdown...`);
    isShuttingDown = true;

    server.close(() => {
      console.log(
        `[${new Date().toISOString()}] Server closed. Exiting process.`
      );
      process.exit(0);
    });

    // Set timeout to force exit if requests don't complete
    const shutdownTimeout = setTimeout(() => {
      console.warn(
        `[${new Date().toISOString()}] Shutdown timeout reached. Forcing exit with ${inFlightRequests.count} in-flight requests.`
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // Monitor in-flight requests
    const checkInterval = setInterval(() => {
      console.log(
        `[${new Date().toISOString()}] In-flight requests: ${inFlightRequests.count}`
      );
      if (inFlightRequests.count === 0) {
        clearInterval(checkInterval);
        clearTimeout(shutdownTimeout);
        server.close(() => {
          console.log(
            `[${new Date().toISOString()}] All requests completed. Exiting.`
          );
          process.exit(0);
        });
      }
    }, 1000);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  server.listen(port, hostname, () => {
    console.log(`[${new Date().toISOString()}] Server listening at http://${hostname}:${port}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
