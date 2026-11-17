import type { CorsOptions } from "cors";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "@/config/env";
import { container } from "@/container";
import { errorHandler, notFoundHandler } from "@/middleware/error.middleware";
import { requestContext } from "@/middleware/request-context.middleware";
import { requestLogger } from "@/middleware/request-logger.middleware";
import { createApiRouter } from "@/routes";

function resolveCorsOrigin(value: string): CorsOptions["origin"] {
    const trimmed = value.trim();
    if (trimmed === "*" || trimmed.length === 0) return true;

    const origins = trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return origins.length === 0 ? true : origins;
}

export function createApp(): Express {
    const app = express();

    app.disable("x-powered-by");
    // Needed for correct client IPs (and therefore sane logs) behind a proxy.
    app.set("trust proxy", true);

    app.use(helmet());
    app.use(cors({ origin: resolveCorsOrigin(env.CORS_ORIGIN), maxAge: 600 }));
    app.use(express.json({ limit: env.JSON_BODY_LIMIT }));

    app.use(requestContext());
    app.use(requestLogger());

    app.use(createApiRouter(container));

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
