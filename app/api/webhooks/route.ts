import { NextRequest, NextResponse } from "next/server";
import {
  registerEndpoint,
  listEndpoints,
  WebhookEventType,
} from "@/lib/webhooks";
import { withLogging } from "@/lib/requestLogger";

const ALLOWED_EVENTS = new Set<WebhookEventType>([
  "schedule.claimed",
  "schedule.revoked",
  "schedule.created",
]);

/**
 * GET /api/webhooks — list all registered webhook endpoints.
 */
export const GET = withLogging(async function GET(): Promise<NextResponse> {
  const endpoints = listEndpoints().map((ep) => ({
    id: ep.id,
    url: ep.url,
    events: ep.events,
    createdAt: ep.createdAt,
    // Never expose the signing secret in list responses
  }));
  return NextResponse.json({ endpoints });
});

/**
 * POST /api/webhooks — register a new webhook endpoint.
 *
 * Body:
 *   url     string               Required. HTTPS endpoint to deliver events to.
 *   events  WebhookEventType[]   Required. At least one of the allowed event types.
 *   secret  string               Optional. Custom HMAC secret (auto-generated if omitted).
 *
 * Response includes the generated `secret` — store it securely, it is not
 * returned again.
 */
export const POST = withLogging(async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  const { url, events, secret } = body as Record<string, unknown>;

  if (typeof url !== "string" || !url.startsWith("https://")) {
    return NextResponse.json(
      { error: "url is required and must start with https://" },
      { status: 400 },
    );
  }

  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json(
      { error: "events must be a non-empty array" },
      { status: 400 },
    );
  }

  const invalid = (events as unknown[]).filter(
    (e) => typeof e !== "string" || !ALLOWED_EVENTS.has(e as WebhookEventType),
  );
  if (invalid.length > 0) {
    return NextResponse.json(
      {
        error: `Unknown event type(s): ${invalid.join(", ")}`,
        allowed: Array.from(ALLOWED_EVENTS),
      },
      { status: 400 },
    );
  }

  const endpoint = registerEndpoint(
    url,
    events as WebhookEventType[],
    typeof secret === "string" ? secret : undefined,
  );

  return NextResponse.json(
    {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      secret: endpoint.secret,
      createdAt: endpoint.createdAt,
    },
    { status: 201 },
  );
});
