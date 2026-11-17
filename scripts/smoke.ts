import { randomUUID } from "node:crypto";

/**
 * End-to-end smoke test.
 *
 * Boots the gateway against a fake upstream LLM server and the real Redis +
 * Postgres from docker-compose, then exercises every endpoint and behaviour:
 * auth, caching, fallback, timeout, rate limiting, validation and accounting.
 *
 *   1. docker compose up -d
 *   2. bunx prisma migrate deploy
 *   3. bun run smoke
 */

const runId = randomUUID().slice(0, 8);
const key = (name: string) => `smoke-${name}-${runId}-key`;

let upstreamCalls = 0;

/** Stand-in for both OpenAI and Gemini, distinguished by path. */
const upstream = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
        upstreamCalls += 1;

        const url = new URL(request.url);
        const body = (await request.json()) as any;
        const isGemini = url.pathname.includes(":generateContent");
        const prompt: string = isGemini ? (body?.contents?.[0]?.parts?.[0]?.text ?? "") : (body?.messages?.[0]?.content ?? "");

        if (!isGemini) {
            if (prompt.includes("FAIL_PRIMARY")) {
                return Response.json({ error: { message: "upstream exploded" } }, { status: 500 });
            }
            if (prompt.includes("SLOW_PRIMARY")) {
                await Bun.sleep(1_500);
            }
            return Response.json({
                model: body?.model ?? "gpt-4o-mini",
                choices: [{ message: { content: `openai:${prompt}` } }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            });
        }

        return Response.json({
            candidates: [{ content: { parts: [{ text: `gemini:${prompt}` }] } }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
        });
    },
});

// Configure the app before it is imported: config/env.ts validates on load.
Object.assign(process.env, {
    NODE_ENV: "test",
    LOG_LEVEL: process.env.SMOKE_LOG_LEVEL ?? "warn",
    OPENAI_API_KEY: "sk-smoke-openai",
    OPENAI_MODEL: "gpt-4o-mini",
    OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    GEMINI_API_KEY: "smoke-gemini-key",
    GEMINI_MODEL: "gemini-2.0-flash",
    GEMINI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1beta`,
    PROVIDER_TIMEOUT_MS: "500",
    RATE_LIMIT_MAX: "10",
    RATE_LIMIT_WINDOW_MS: "60000",
    RATE_LIMIT_FAIL_OPEN: "false",
    CACHE_ENABLED: "true",
    CACHE_TTL_SECONDS: "3600",
    ALLOW_CROSS_KEY_USAGE: "false",
    API_KEYS: "",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://gateway:gateway@localhost:5432/llm_gateway",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
});

const { createApp } = await import("../src/app");
const { closeRedis, pingRedis } = await import("../src/lib/redis");
const { closeDatabase, pingDatabase, prisma } = await import("../src/lib/prisma");

const results: { name: string; ok: boolean }[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
    results.push({ name, ok });
    const suffix = ok || detail === undefined ? "" : `  <- ${JSON.stringify(detail)}`;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${suffix}`);
}

const [redisUp, databaseUp] = await Promise.all([pingRedis(), pingDatabase()]);
if (!redisUp || !databaseUp) {
    console.error(
        `\nInfrastructure is not reachable (redis=${redisUp ? "up" : "down"}, postgres=${databaseUp ? "up" : "down"}).\n` +
        "Run `docker compose up -d` and `bunx prisma migrate deploy` first.\n",
    );
    upstream.stop(true);
    process.exit(1);
}

const server = createApp().listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));

const address = server.address();
if (!address || typeof address === "string") throw new Error("unexpected server address");
const base = `http://127.0.0.1:${address.port}`;

interface ApiResponse {
    status: number;
    body: any;
    headers: Headers;
}

async function call(
    path: string,
    options: { method?: string; apiKey?: string; body?: unknown } = {},
): Promise<ApiResponse> {
    const headers: Record<string, string> = {};
    if (options.apiKey) headers["x-api-key"] = options.apiKey;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const response = await fetch(`${base}${path}`, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    let body: any = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }

    return { status: response.status, body, headers: response.headers };
}

try {
    // --------------------------------------------------------------------- health
    const health = await call("/health");
    check("GET /health reports ok", health.status === 200 && health.body?.status === "ok", health.body);

    // ----------------------------------------------------------------------- auth
    const missingKey = await call("/chat", { body: { prompt: "hi", provider: "openai" } });
    check(
        "POST /chat without a key is 401",
        missingKey.status === 401 && missingKey.body?.error?.code === "missing_api_key",
        missingKey.body,
    );

    // ----------------------------------------------------- primary provider + tokens
    const chatKey = key("chat");
    const prompt = `hello gateway ${runId}`;

    const first = await call("/chat", { apiKey: chatKey, body: { prompt, provider: "openai" } });
    check("POST /chat returns 200", first.status === 200, first.body);
    check("primary provider answered", first.body?.provider === "openai" && first.body?.model === "gpt-4o-mini", first.body);
    check("upstream text is passed through", first.body?.response === `openai:${prompt}`, first.body?.response);
    check(
        "token usage is mapped",
        first.body?.usage?.promptTokens === 10 && first.body?.usage?.responseTokens === 5 && first.body?.usage?.totalTokens === 15,
        first.body?.usage,
    );
    check("cost is estimated in USD", typeof first.body?.estimatedCostUsd === "number" && first.body.estimatedCostUsd > 0, first.body?.estimatedCostUsd);
    check("first call is not cached", first.body?.cached === false, first.body?.cached);
    check(
        "rate limit headers are exposed",
        first.headers.get("x-ratelimit-limit") === "10" && first.headers.get("x-ratelimit-remaining") === "9",
        { limit: first.headers.get("x-ratelimit-limit"), remaining: first.headers.get("x-ratelimit-remaining") },
    );

    // ---------------------------------------------------------------------- cache
    const second = await call("/chat", { apiKey: chatKey, body: { prompt, provider: "openai" } });
    check("repeat prompt is served from cache", second.status === 200 && second.body?.cached === true, second.body);
    check("cached response matches the original", second.body?.response === first.body?.response, second.body?.response);
    check("cached response costs nothing", second.body?.estimatedCostUsd === 0, second.body?.estimatedCostUsd);
    check("upstream was called exactly once", upstreamCalls === 1, { upstreamCalls });

    // ---------------------------------------------------------------------- usage
    const usage = await call(`/usage/${chatKey}`, { apiKey: chatKey });
    check("GET /usage returns 200", usage.status === 200, usage.body);
    check("usage counts every request", usage.body?.totalRequests === 2, usage.body?.totalRequests);
    check("usage tokens exclude cache hits", usage.body?.totalTokens === 15, usage.body?.totalTokens);
    check("usage cost is aggregated", typeof usage.body?.totalEstimatedCostUsd === "number" && usage.body.totalEstimatedCostUsd > 0, usage.body?.totalEstimatedCostUsd);
    check("usage key is masked", typeof usage.body?.apiKey === "string" && usage.body.apiKey.startsWith("***"), usage.body?.apiKey);

    const crossKey = await call(`/usage/${chatKey}`, { apiKey: key("intruder") });
    check(
        "cross-key usage is forbidden",
        crossKey.status === 403 && crossKey.body?.error?.code === "usage_forbidden",
        crossKey.body,
    );

    // ------------------------------------------------------------------- fallback
    const fallbackKey = key("fallback");
    const fallback = await call("/chat", {
        apiKey: fallbackKey,
        body: { prompt: `FAIL_PRIMARY ${runId}`, provider: "openai" },
    });
    check(
        "provider failure falls back to gemini",
        fallback.status === 200 && fallback.body?.provider === "gemini" && fallback.body?.fallback === true,
        fallback.body,
    );
    check("fallback reports the failed attempt", fallback.body?.attempts?.[0]?.status === "error", fallback.body?.attempts);
    check(
        "fallback response comes from the secondary provider",
        fallback.body?.response === `gemini:FAIL_PRIMARY ${runId}`,
        fallback.body?.response,
    );

    // -------------------------------------------------------------------- timeout
    const timeoutKey = key("timeout");
    const timeoutStartedAt = Date.now();
    const timeout = await call("/chat", {
        apiKey: timeoutKey,
        body: { prompt: `SLOW_PRIMARY ${runId}`, provider: "openai" },
    });
    const timeoutElapsed = Date.now() - timeoutStartedAt;
    check(
        "provider timeout falls back to gemini",
        timeout.status === 200 && timeout.body?.provider === "gemini" && timeout.body?.fallback === true,
        timeout.body,
    );
    check("timeout is classified as such", timeout.body?.attempts?.[0]?.error?.kind === "timeout", timeout.body?.attempts);
    check("deadline is enforced", timeoutElapsed < 1_200, { timeoutElapsed });

    // ---------------------------------------------------------------- rate limiting
    const rateLimitKey = key("ratelimit");
    let allowed = 0;
    let blocked: ApiResponse | undefined;

    for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await call("/chat", {
            apiKey: rateLimitKey,
            body: { prompt: `rate probe ${attempt} ${runId}`, provider: "openai" },
        });
        if (response.status === 200) allowed += 1;
        else if (response.status === 429) {
            blocked = response;
            break;
        }
    }

    check("ten requests per minute are allowed", allowed === 10, { allowed });
    check(
        "eleventh request is rejected with 429",
        blocked?.status === 429 && blocked.body?.error?.code === "rate_limit_exceeded",
        blocked?.body,
    );
    check("429 includes a Retry-After header", Number(blocked?.headers.get("retry-after") ?? 0) > 0, blocked?.headers.get("retry-after"));

    // ---------------------------------------------------------------- validation
    const emptyPrompt = await call("/chat", { apiKey: key("validation"), body: { prompt: "   ", provider: "openai" } });
    check(
        "empty prompt is a 400",
        emptyPrompt.status === 400 && emptyPrompt.body?.error?.code === "validation_error",
        emptyPrompt.body,
    );

    const badProvider = await call("/chat", {
        apiKey: key("validation"),
        body: { prompt: "hi", provider: "anthropic" },
    });
    check("unknown provider is a 400", badProvider.status === 400, badProvider.body);

    const unknownRoute = await call("/does-not-exist");
    check("unknown route is a 404", unknownRoute.status === 404 && unknownRoute.body?.error?.code === "route_not_found", unknownRoute.body);

    // -------------------------------------------------------------- persistence
    const rows = await prisma.apiUsage.findMany({ where: { apiKey: chatKey }, orderBy: { timestamp: "asc" } });
    check("ApiUsage rows are persisted", rows.length === 2, { rows: rows.length });
    check(
        "ApiUsage row carries provider, tokens and cost",
        rows[0]?.provider === "openai" &&
        rows[0]?.promptTokens === 10 &&
        rows[0]?.responseTokens === 5 &&
        Number(rows[0]?.estimatedCost) > 0,
        rows[0],
    );
    check("cached row is flagged", rows[1]?.cached === true && rows[1]?.status === "cached", rows[1]);
} finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    upstream.stop(true);
    await closeRedis();
    await closeDatabase();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
    console.error(`Failed checks: ${failed.map((result) => result.name).join(", ")}`);
    process.exit(1);
}
