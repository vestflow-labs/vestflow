import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z, type ZodTypeAny } from "zod";

import { ApiError } from "../types/errors.js";

interface Schemas {
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  body?: ZodTypeAny;
}

/**
 * Validate `req.params` / `req.query` / `req.body` against `schemas` and
 * replace them with the parsed (coerced, stripped) values, so handlers only
 * ever see trusted data. A missing `body` schema means no body validation is
 * performed (an absent or empty body is still allowed).
 *
 * On validation failure a 422 `ApiError` is passed to `next` with
 * `{ field, message }[]` details, so clients can render field-level errors.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as typeof req.params;
      }
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query) as Record<string, unknown>;
        // Express 5 exposes `req.query` via a getter, so assign field-by-field
        // through a cast rather than replacing the property.
        Object.assign(req.query as object, parsed);
      }
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map((issue) => ({
          field: issue.path.length > 0 ? issue.path.join(".") : "body",
          message: issue.message,
        }));
        next(ApiError.unprocessable("Validation failed", details));
        return;
      }
      next(error);
    }
  };
}
