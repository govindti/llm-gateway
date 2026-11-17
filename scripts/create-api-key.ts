import { parseArgs } from "node:util";
import { prisma } from "@/lib/prisma";
import { PrismaAuthRepository } from "@/services/auth.repository";
import { AuthService } from "@/services/auth.service";
import type { ApiKeyRole } from "@/services/auth.contracts";
import type { CacheStore } from "@/services/cache.service";

/**
 * Bootstraps credentials straight from the CLI, which is the only way to mint
 * the first admin key (the HTTP API requires an admin to already exist).
 *
 *   bun run auth:key --name "local dev" --role admin
 *   bun run auth:key --name "reporting job" --days 90
 */

const { values } = parseArgs({
    options: {
        name: { type: "string" },
        role: { type: "string" },
        days: { type: "string" },
        help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
});

function usage(message?: string): never {
    if (message) console.error(`\n${message}\n`);
    console.log(
        [
            "Usage: bun run auth:key --name <name> [--role admin|member] [--days <n>]",
            "",
            "  --name   Human readable label for the key (required)",
            "  --role   'member' (default) or 'admin'",
            "  --days   Optional expiry, in days from now",
        ].join("\n"),
    );
    process.exit(message ? 1 : 0);
}

if (values.help) usage();
if (!values.name || values.name.trim().length === 0) usage("--name is required");

const role = (values.role ?? "member").toLowerCase();
if (role !== "admin" && role !== "member") usage(`--role must be 'admin' or 'member', received '${values.role}'`);

const days = values.days === undefined ? undefined : Number(values.days);
if (days !== undefined && (!Number.isInteger(days) || days < 1)) usage("--days must be a positive integer");

// This command only issues keys, so no cache or Redis connection is needed.
const noCache: CacheStore = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
};

const authService = new AuthService(new PrismaAuthRepository(prisma), noCache, {
    staticAdminKeys: [],
    cacheTtlSeconds: 0,
});

try {
    const issued = await authService.createKey({
        name: values.name.trim(),
        role: role as ApiKeyRole,
        expiresInDays: days,
    });

    console.log(`\nCreated API key "${issued.record.name}" (role: ${issued.record.role})`);
    console.log(`  id:     ${issued.record.id}`);
    console.log(`  prefix: ${issued.record.keyPrefix}`);
    console.log(`  key:    ${issued.apiKey}`);
    if (issued.record.expiresAt) console.log(`  expiry: ${issued.record.expiresAt.toISOString()}`);
    console.log("\nStore it now: only the SHA-256 hash is persisted and the key cannot be shown again.\n");
} finally {
    await prisma.$disconnect();
}
