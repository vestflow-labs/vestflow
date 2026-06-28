import type { NextFunction, Request, Response } from 'express';

export type ErrorResponseBody = {
  message: string;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response<ErrorResponseBody>,
  _next: NextFunction
): Response<ErrorResponseBody> {
  const message = err instanceof Error ? err.message : 'Internal Server Error';

  // For this boilerplate we default to 500.
  return res.status(500).json({ message });
}

