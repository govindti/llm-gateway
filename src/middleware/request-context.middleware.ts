import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Assigns a correlation id to every request, reusing a well-formed inbound
 * `x-request-id` so logs stay connected across upstream services.
 */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header("x-request-id");
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();

    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  };
}
