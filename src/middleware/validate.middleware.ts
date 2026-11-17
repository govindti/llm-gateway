import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { badRequest } from "@/utils/errors";

/**
 * Validates and (for bodies) replaces the payload with the parsed value, so
 * handlers only ever see normalised data. Rejections surface as 400 with the
 * per-field issues.
 */
export function validate<T>(schema: ZodType<T>, source: "body" | "params" = "body"): RequestHandler {
    return (req, _res, next) => {
        const result = schema.safeParse(req[source]);

        if (!result.success) {
            return next(
                badRequest(
                    `Invalid request ${source}`,
                    result.error.issues.map((issue) => ({
                        path: issue.path.join("."),
                        message: issue.message,
                    })),
                ),
            );
        }

        if (source === "body") {
            req.body = result.data;
        } else {
            req.params = result.data as typeof req.params;
        }

        next();
    };
}
