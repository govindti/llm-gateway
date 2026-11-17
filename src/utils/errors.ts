/**
 * Application error with an HTTP status and a stable machine-readable code.
 * Anything thrown that is not an AppError is treated as an unexpected 500.
 */
export class AppError extends Error {
    readonly statusCode: number;
    readonly code: string;
    readonly details?: unknown;

    constructor(statusCode: number, code: string, message: string, details?: unknown) {
        super(message);
        this.name = "AppError";
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        Error.captureStackTrace?.(this, AppError);
    }
}

export const badRequest = (message: string, details?: unknown) =>
    new AppError(400, "validation_error", message, details);

export const unauthorized = (message: string, code = "unauthorized") => new AppError(401, code, message);

export const forbidden = (message: string, code = "forbidden") => new AppError(403, code, message);

export const notFound = (message: string, code = "not_found") => new AppError(404, code, message);

export const serviceUnavailable = (message: string, code = "service_unavailable") =>
    new AppError(503, code, message);
