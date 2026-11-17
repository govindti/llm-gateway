import type { AuthIdentity } from "@/services/auth.contracts";

/**
 * Values attached to the request by middleware, in execution order:
 *   requestContext -> requestId
 *   authenticate   -> auth, apiKey
 */
declare global {
    namespace Express {
        interface Request {
            /** Correlation id, also returned as the `x-request-id` response header. */
            requestId: string;
            /** Resolved caller identity: role, credential id and expiry. */
            auth?: AuthIdentity;
            /** Raw caller key resolved from `x-api-key` or `Authorization: Bearer`. */
            apiKey?: string;
        }
    }
}

export { };
