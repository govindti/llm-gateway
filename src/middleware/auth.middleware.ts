import type { Request, RequestHandler } from "express";
import type { ApiKeyRole, AuthIdentity } from "@/services/auth.contracts";
import type { AuthService } from "@/services/auth.service";
import { forbidden, unauthorized } from "@/utils/errors";

/** Reads the caller key from `x-api-key`, falling back to `Authorization: Bearer`. */
export function extractApiKey(req: Request): string | undefined {
    const headerKey = req.header("x-api-key");
    if (headerKey && headerKey.trim().length > 0) return headerKey.trim();

    const authorization = req.header("authorization");
    if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
        const bearer = authorization.slice("bearer ".length).trim();
        return bearer.length > 0 ? bearer : undefined;
    }

    return undefined;
}

/**
 * Resolves the caller to an `AuthIdentity` and attaches it to the request.
 * Everything downstream (rate limiting, usage accounting, authorization) keys
 * off that identity.
 */
export function authenticate(authService: AuthService): RequestHandler {
    return (req, _res, next) => {
        void (async () => {
            const apiKey = extractApiKey(req);
            if (!apiKey) {
                throw unauthorized(
                    "Missing API key. Send it as the 'x-api-key' header or as 'Authorization: Bearer <key>'.",
                    "missing_api_key",
                );
            }

            const identity = await authService.authenticate(apiKey);
            req.auth = identity;
            req.apiKey = identity.apiKey;
            next();
        })().catch(next);
    };
}

/** Authorization guard for endpoints restricted by role. */
export function requireRole(...roles: ApiKeyRole[]): RequestHandler {
    return (req, _res, next) => {
        const identity = req.auth;
        if (!identity) return next(unauthorized("Missing API key.", "missing_api_key"));

        if (!roles.includes(identity.role)) {
            return next(
                forbidden(`This endpoint requires the '${roles.join("' or '")}' role.`, "insufficient_role"),
            );
        }

        next();
    };
}

/** Narrowing helper for handlers that run behind `authenticate`. */
export function requireAuth(req: Request): AuthIdentity {
    if (!req.auth) throw unauthorized("Missing API key.", "missing_api_key");
    return req.auth;
}

/** Convenience for handlers that only need the key scoping rate limits and usage. */
export function requireApiKey(req: Request): string {
    return requireAuth(req).apiKey;
}
