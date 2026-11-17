type LogLevel = "debug" | "info" | "warn" | "error";

type LogMeta = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

/**
 * Reads LOG_LEVEL lazily so modules can be imported before env validation runs
 * (tests, scripts) without crashing on a missing variable.
 */
function activeLevel(): LogLevel {
    const configured = process.env.LOG_LEVEL as LogLevel | undefined;
    return configured && configured in LEVEL_PRIORITY ? configured : "info";
}

function emit(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[activeLevel()]) return;

    const record = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...meta,
    };

    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
}

export interface Logger {
    debug(message: string, meta?: LogMeta): void;
    info(message: string, meta?: LogMeta): void;
    warn(message: string, meta?: LogMeta): void;
    error(message: string, meta?: LogMeta): void;
    child(bindings: LogMeta): Logger;
}

export const logger: Logger = {
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
    child: (bindings) => ({
        debug: (message, meta) => emit("debug", message, { ...bindings, ...meta }),
        info: (message, meta) => emit("info", message, { ...bindings, ...meta }),
        warn: (message, meta) => emit("warn", message, { ...bindings, ...meta }),
        error: (message, meta) => emit("error", message, { ...bindings, ...meta }),
        child: (nested) => logger.child({ ...bindings, ...nested }),
    }),
};

/** Normalises unknown thrown values into a loggable string. */
export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}
