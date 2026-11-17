import type { ProviderName } from "./types";

export type ProviderFailureKind =
    | "not_configured"
    | "http_error"
    | "timeout"
    | "network"
    | "invalid_response";

/**
 * Normalised upstream failure. Carrying the provider and a failure kind lets the
 * orchestrator decide whether to fall back and lets the API answer with a stable
 * error shape without leaking credentials.
 */
export class ProviderError extends Error {
    readonly provider: ProviderName;
    readonly kind: ProviderFailureKind;
    readonly statusCode?: number;

    constructor(
        provider: ProviderName,
        kind: ProviderFailureKind,
        message: string,
        statusCode?: number,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = "ProviderError";
        this.provider = provider;
        this.kind = kind;
        this.statusCode = statusCode;
    }

    /** A missing credential will never succeed on retry with the same provider. */
    get retryable(): boolean {
        return this.kind !== "not_configured";
    }
}

/** True for both `AbortSignal.timeout` (TimeoutError) and manual aborts. */
export function isAbortError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const name = (error as { name?: unknown }).name;
    return name === "AbortError" || name === "TimeoutError";
}
