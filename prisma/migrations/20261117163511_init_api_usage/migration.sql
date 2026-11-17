-- CreateTable
CREATE TABLE "ApiUsage" (
    "id" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'unknown',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "responseTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'success',
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "fallback" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiUsage_apiKey_timestamp_idx" ON "ApiUsage"("apiKey", "timestamp");

-- CreateIndex
CREATE INDEX "ApiUsage_provider_timestamp_idx" ON "ApiUsage"("provider", "timestamp");
