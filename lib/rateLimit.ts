import { NextRequest, NextResponse } from "next/server";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (request: NextRequest) => string;
}

interface RequestMetrics {
  count: number;
  resetTime: number;
}

const store = new Map<string, RequestMetrics>();

const cleanupStore = () => {
  const now = Date.now();
  for (const [key, metrics] of store.entries()) {
    if (now > metrics.resetTime) {
      store.delete(key);
    }
  }
};

export function createRateLimiter(config: RateLimitConfig) {
  const {
    windowMs,
    maxRequests,
    keyGenerator = (req: NextRequest) => {
      const forwardedFor = req.headers.get("x-forwarded-for");
      const clientIp = forwardedFor ? forwardedFor.split(",")[0].trim() : "unknown";
      return clientIp;
    },
  } = config;

  return async (request: NextRequest): Promise<NextResponse | null> => {
    cleanupStore();

    const key = keyGenerator(request);
    const now = Date.now();
    let metrics = store.get(key);

    if (!metrics || now > metrics.resetTime) {
      metrics = {
        count: 0,
        resetTime: now + windowMs,
      };
      store.set(key, metrics);
    }

    metrics.count++;

    if (metrics.count > maxRequests) {
      const resetTime = metrics.resetTime;
      const retryAfter = Math.ceil((resetTime - now) / 1000);
      return new NextResponse(
        JSON.stringify({
          error: "Too many requests",
          message: `Rate limit exceeded. Maximum ${maxRequests} requests per ${Math.floor(windowMs / 1000)} seconds allowed.`,
          retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Retry-After": retryAfter.toString(),
            "Content-Type": "application/json",
          },
        }
      );
    }

    return null;
  };
}

export function createIpBasedRateLimiter(windowMs: number, maxRequests: number) {
  return createRateLimiter({
    windowMs,
    maxRequests,
  });
}

export function createEndpointSpecificRateLimiter(
  windowMs: number,
  maxRequests: number,
  endpoint: string
) {
  return createRateLimiter({
    windowMs,
    maxRequests,
    keyGenerator: (req: NextRequest) => {
      const forwardedFor = req.headers.get("x-forwarded-for");
      const clientIp = forwardedFor ? forwardedFor.split(",")[0].trim() : "unknown";
      return `${endpoint}:${clientIp}`;
    },
  });
}
