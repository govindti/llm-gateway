import { z } from "zod";

/**
 * Booleans arrive as strings from the environment.
 */
const booleanEnv = (defaultValue: boolean) =>
    z
        .enum(["true", "false", "1", "0"])
        .default(defaultValue ? "true" : "false")
        .transform((value) => value === "true" || value === "1");

/** Empty strings are treated as "not set" so `OPENAI_API_KEY=` disables a provider. */
const optionalSecret = z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

const csv = z
    .string()
    .optional()
    .transform((value) =>
        (value ?? "")
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
    );

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    JSON_BODY_LIMIT: z.string().default("256kb"),
    CORS_ORIGIN: z.string().default("*"),

    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),

    OPENAI_API_KEY: optionalSecret,
    OPENAI_MODEL: z.string().default("gpt-4o-mini"),
    OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),

    GEMINI_API_KEY: optionalSecret,
    GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
    GEMINI_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta"),

    PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_FAIL_OPEN: booleanEnv(true),

    CACHE_ENABLED: booleanEnv(true),
    CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),

    API_KEYS: csv,

    /** How long a validated key stays cached before Postgres is consulted again. */
    AUTH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
    const parsed = envSchema.safeParse(process.env);

    if (!parsed.success) {
        const problems = parsed.error.issues
            .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        // Fail fast: the process cannot serve traffic with an invalid configuration.
        console.error(`Invalid environment configuration:\n${problems}\n\nCopy .env.example to .env and try again.`);
        process.exit(1);
    }

    return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
