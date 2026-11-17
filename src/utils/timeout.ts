export class TimeoutError extends Error {
    readonly label: string;
    readonly timeoutMs: number;

    constructor(label: string, timeoutMs: number) {
        super(`${label} timed out after ${timeoutMs}ms`);
        this.name = "TimeoutError";
        this.label = label;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * Hard deadline backstop for a promise. Providers additionally receive an
 * AbortSignal so the underlying socket is cancelled, not just ignored.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
