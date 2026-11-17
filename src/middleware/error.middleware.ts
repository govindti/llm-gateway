import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { errorMessage, logger } from "@/lib/logger";
import { AppError } from "@/utils/errors";

export const notFoundHandler: RequestHandler = (req, res) => {
    res.status(404).json({
        error: {
            code: "route_not_found",
            message: `Route ${req.method} ${req.originalUrl} does not exist.`,
        },
        requestId: req.requestId,
    });
};

/** Body-parser failures (malformed JSON, payload too large) carry a `type`. */
function isBodyParserError(error: unknown): error is { type: string; message: string; status: number } {
    return (
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        typeof (error as { type: unknown }).type === "string" &&
        (error as { type: string }).type.startsWith("entity.")
    );
}

export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
    // Headers already flushed: let Express tear the connection down.
    if (res.headersSent) {
        next(error);
        return;
    }

    if (error instanceof AppError) {
        res.status(error.statusCode).json({
            error: {
                code: error.code,
                message: error.message,
                ...(error.details === undefined ? {} : { details: error.details }),
            },
            requestId: req.requestId,
        });
        return;
    }

    if (error instanceof ZodError) {
        res.status(400).json({
            error: {
                code: "validation_error",
                message: "Invalid request payload",
                details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
            },
            requestId: req.requestId,
        });
        return;
    }

    if (isBodyParserError(error)) {
        res.status(400).json({
            error: { code: "invalid_request_body", message: error.message },
            requestId: req.requestId,
        });
        return;
    }

    logger.error("unhandled request error", {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
        error: { code: "internal_error", message: "Unexpected server error." },
        requestId: req.requestId,
    });
}
