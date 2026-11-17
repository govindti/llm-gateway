import type { RequestHandler } from "express";
import { logger } from "@/lib/logger";
import { maskApiKey } from "@/utils/mask";

/** Emits one structured log line per completed response. */
export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();

    res.on("finish", () => {
      logger.info("http request", {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        apiKey: req.apiKey ? maskApiKey(req.apiKey) : undefined,
      });
    });

    next();
  };
}
