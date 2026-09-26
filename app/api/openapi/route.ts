import { NextResponse } from "next/server";
import { withLogging } from "@/lib/requestLogger";

/**
 * Hand-authored OpenAPI 3 spec for VestFlow's API routes (#210).
 *
 * This is a Next.js App Router API, not NestJS/Express, so there's no
 * decorator-based auto-generator (e.g. `@nestjs/swagger`) available for
 * this stack. Every path below corresponds to a real route handler under
 * `app/api/**\/route.ts` at the time this was written — none are
 * speculative. If a route is added, removed, or its shape changes, this
 * spec needs a matching manual update (there is currently no CI check
 * enforcing that; a reasonable follow-up would be a script that diffs the
 * `app/api` route tree against this spec's `paths` keys).
 */
const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "VestFlow API",
    version: "1.0.0",
    description:
      "Read-only API for VestFlow vesting schedule state, analytics, and notification management. Write operations (creating/claiming/revoking schedules) happen via direct contract calls from the client, not through this API.",
  },
  servers: [{ url: "/api" }],
  tags: [
    { name: "schedules", description: "Vesting schedule reads" },
    { name: "notifications", description: "Push notification subscriptions" },
    { name: "webhooks", description: "Outbound event webhooks" },
    { name: "meta", description: "Health, readiness, contract/version info" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["meta"],
        summary: "Liveness check",
        responses: { "200": { description: "Service is up" } },
      },
    },
    "/ready": {
      get: {
        tags: ["meta"],
        summary: "Readiness check (dependencies reachable)",
        responses: {
          "200": { description: "Service and its dependencies are ready" },
          "503": { description: "Not ready" },
        },
      },
    },
    "/contracts/version": {
      get: {
        tags: ["meta"],
        summary: "Deployed VestFlow contract version",
        responses: { "200": { description: "Contract version number" } },
      },
    },
    "/analytics/stats": {
      get: {
        tags: ["meta"],
        summary: "Aggregate protocol analytics",
        responses: { "200": { description: "Analytics summary" } },
      },
    },
    "/stats/tvl": {
      get: {
        tags: ["meta"],
        summary: "Total value locked across all schedules",
        responses: { "200": { description: "TVL figure" } },
      },
    },
    "/events": {
      get: {
        tags: ["meta"],
        summary: "Recent on-chain vesting events",
        responses: { "200": { description: "Event list" } },
      },
    },
    "/schedules": {
      get: {
        tags: ["schedules"],
        summary: "List vesting schedules",
        responses: {
          "200": {
            description: "Paginated list of schedules",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ScheduleList" },
              },
            },
          },
        },
      },
    },
    "/schedules/search": {
      get: {
        tags: ["schedules"],
        summary: "Search schedules",
        parameters: [
          {
            name: "q",
            in: "query",
            schema: { type: "string" },
            description: "Search term (address, schedule ID, etc.)",
          },
        ],
        responses: { "200": { description: "Matching schedules" } },
      },
    },
    "/schedules/simulate": {
      post: {
        tags: ["schedules"],
        summary: "Simulate a schedule's vesting curve without creating it on-chain",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SimulateScheduleRequest" },
            },
          },
        },
        responses: { "200": { description: "Simulated vesting curve points" } },
      },
    },
    "/schedules/{id}": {
      get: {
        tags: ["schedules"],
        summary: "Get a schedule's current state",
        parameters: [{ $ref: "#/components/parameters/ScheduleId" }],
        responses: {
          "200": {
            description: "Schedule with derived current-state fields",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ScheduleDetail" },
              },
            },
          },
          "404": { description: "Schedule not found" },
        },
      },
    },
    "/schedules/{id}/claimable": {
      get: {
        tags: ["schedules"],
        summary: "Get a schedule's currently claimable amount",
        parameters: [{ $ref: "#/components/parameters/ScheduleId" }],
        responses: { "200": { description: "Claimable amount (stroops, as a string)" } },
      },
    },
    "/schedules/{id}/history": {
      get: {
        tags: ["schedules"],
        summary: "Get a schedule's event history",
        parameters: [{ $ref: "#/components/parameters/ScheduleId" }],
        responses: { "200": { description: "Ordered event history for this schedule" } },
      },
    },
    "/schedules/{address}/history": {
      get: {
        tags: ["schedules"],
        summary: "Get event history for all schedules involving an address",
        parameters: [{ $ref: "#/components/parameters/Address" }],
        responses: { "200": { description: "Event history across the address's schedules" } },
      },
    },
    "/schedules/grantor/{address}": {
      get: {
        tags: ["schedules"],
        summary: "List schedule IDs created by a grantor address",
        parameters: [{ $ref: "#/components/parameters/Address" }],
        responses: { "200": { description: "Schedule IDs" } },
      },
    },
    "/schedules/beneficiary/{address}": {
      get: {
        tags: ["schedules"],
        summary: "List schedule IDs where an address is the beneficiary",
        parameters: [{ $ref: "#/components/parameters/Address" }],
        responses: { "200": { description: "Schedule IDs" } },
      },
    },
    "/notifications/subscribe": {
      post: {
        tags: ["notifications"],
        summary: "Subscribe to push notifications for a schedule",
        responses: { "200": { description: "Subscription created" } },
      },
    },
    "/notifications/unsubscribe": {
      post: {
        tags: ["notifications"],
        summary: "Unsubscribe from push notifications",
        responses: { "200": { description: "Subscription removed" } },
      },
    },
    "/notifications/verify": {
      get: {
        tags: ["notifications"],
        summary: "Verify a notification subscription (e.g. via emailed link)",
        responses: { "200": { description: "Subscription verified" } },
      },
    },
    "/webhooks": {
      get: {
        tags: ["webhooks"],
        summary: "List registered webhooks",
        responses: { "200": { description: "Webhook list" } },
      },
      post: {
        tags: ["webhooks"],
        summary: "Register a new webhook",
        responses: { "201": { description: "Webhook registered" } },
      },
    },
    "/webhooks/{id}": {
      get: {
        tags: ["webhooks"],
        summary: "Get a webhook by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Webhook details" },
          "404": { description: "Webhook not found" },
        },
      },
      delete: {
        tags: ["webhooks"],
        summary: "Delete a webhook",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "204": { description: "Webhook deleted" },
          "404": { description: "Webhook not found" },
        },
      },
    },
  },
  components: {
    parameters: {
      ScheduleId: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "integer" },
        description: "Numeric vesting schedule ID",
      },
      Address: {
        name: "address",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Stellar account address (G...)",
      },
    },
    schemas: {
      Schedule: {
        type: "object",
        properties: {
          id: { type: "integer" },
          grantor: { type: "string" },
          beneficiary: { type: "string" },
          token: { type: "string" },
          total_amount: { type: "string", description: "Stroops, as a string (i128 doesn't fit in a JS number)" },
          claimed: { type: "string" },
          start_time: { type: "integer" },
          duration: { type: "integer" },
          cliff_duration: { type: "integer" },
          lockup_duration: { type: "integer" },
          kind: { type: "string", enum: ["Linear", "Cliff", "LinearWithCliff", "Graded"] },
          revocable: { type: "boolean" },
          revoked: { type: "boolean" },
          paused: { type: "boolean" },
          requires_milestones: { type: "boolean" },
        },
      },
      ScheduleDetail: {
        allOf: [
          { $ref: "#/components/schemas/Schedule" },
          {
            type: "object",
            properties: {
              currentState: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["pending", "vesting", "fully_vested", "revoked"] },
                  progress: { type: "number" },
                  vestedAmount: { type: "string" },
                  claimableAmount: { type: "string" },
                  remainingAmount: { type: "string" },
                  unclaimedVested: { type: "string" },
                },
              },
              nextUnlockTimestamp: { type: "integer", nullable: true },
              network: { type: "string" },
              timestamp: { type: "integer" },
            },
          },
        ],
      },
      ScheduleList: {
        type: "object",
        properties: {
          schedules: { type: "array", items: { $ref: "#/components/schemas/Schedule" } },
        },
      },
      SimulateScheduleRequest: {
        type: "object",
        properties: {
          total_amount: { type: "string" },
          start_time: { type: "integer" },
          duration: { type: "integer" },
          cliff_duration: { type: "integer" },
          kind: { type: "string", enum: ["Linear", "Cliff", "LinearWithCliff", "Graded"] },
        },
      },
    },
  },
};

export const GET = withLogging(async function GET() {
  return NextResponse.json(openApiSpec);
});
