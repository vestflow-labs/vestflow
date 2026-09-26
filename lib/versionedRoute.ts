import { NextRequest, NextResponse } from "next/server";

export function createVersionedHandler(
  handler: (request: NextRequest, ...args: any[]) => Promise<NextResponse>
) {
  return async (request: NextRequest, ...args: any[]): Promise<NextResponse> => {
    const response = await handler(request, ...args);

    const version = request.headers.get("x-api-version");
    if (version) {
      response.headers.set("API-Version", version);
    }

    const isDeprecated = request.headers.get("x-is-deprecated") === "true";
    if (isDeprecated) {
      const sunsetDate = new Date();
      sunsetDate.setFullYear(sunsetDate.getFullYear() + 1);
      response.headers.set("Deprecation", "true");
      response.headers.set("Sunset", sunsetDate.toUTCString());
      response.headers.set(
        "Link",
        `<https://docs.vestflow.dev/api/migration>; rel="deprecation"`
      );
    }

    return response;
  };
}
