/**
 * Error type carrying the HTTP status and a stable machine-readable code, so
 * route handlers can `throw new ApiError(404, "schedule_not_found", "...")`
 * without repeating response-shaping logic in every catch block.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  public constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  public static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, "bad_request", message, details);
  }

  public static notFound(message: string, details?: unknown): ApiError {
    return new ApiError(404, "not_found", message, details);
  }

  public static unprocessable(message: string, details?: unknown): ApiError {
    return new ApiError(422, "unprocessable", message, details);
  }

  public static upstream(message: string, details?: unknown): ApiError {
    return new ApiError(502, "upstream_error", message, details);
  }
}

/** Serialise any thrown value into the API's error envelope. */
export function describeError(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  return {
    status: 500,
    code: "internal_error",
    message:
      error instanceof Error ? error.message : "Unexpected server error",
  };
}
